import { Inject, Injectable, Logger } from '@nestjs/common';
import { workerEnvironmentSchema } from '@osc/contracts';
import { createPrismaClient } from '@osc/db';
import {
  composeProjectionDocuments,
  projectionCandidateSetDigest,
  projectionConfigSchema,
  projectionDependencyKeys,
  projectionReconcileToken,
  projectionReconcileTokenHash,
  protectedKeyHmac,
  stableJson,
  type CanonicalKeyPart,
  type ProjectionConfig,
} from '@osc/ingestion';
import type { Client } from 'pg';
import { createHash } from 'node:crypto';

import {
  ProjectionSnapshotService,
  tsDelete,
} from './projection-snapshot.service.js';
import { ProjectionSyncService } from './projection-sync.service.js';

const config = workerEnvironmentSchema.parse(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);
const APPROVAL_TTL_MS = 30 * 60_000;

async function loadRun(id: string) {
  return prisma.projectionReconcileRun.findUnique({
    where: { id },
    include: {
      projectionVersion: true,
      projectionGeneration: true,
      activeIndexGeneration: true,
      projection: {
        include: {
          source: true,
          activeVersion: true,
          searchIndex: {
            include: {
              project: { include: { typesenseConnection: true } },
            },
          },
          generations: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
}

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

@Injectable()
export class ProjectionReconcileService {
  private readonly logger = new Logger(ProjectionReconcileService.name);

  constructor(
    @Inject(ProjectionSnapshotService)
    private readonly runtime: ProjectionSnapshotService,
    @Inject(ProjectionSyncService)
    private readonly sync: ProjectionSyncService,
  ) {}

  async process(
    reconcileRunId: string,
    action: 'scan' | 'execute',
    finalAttempt: boolean,
  ): Promise<void> {
    if (!config.ENABLE_RELATIONAL_PROJECTIONS) return;
    if (action === 'execute') {
      await this.execute(reconcileRunId, finalAttempt);
      return;
    }
    await this.scan(reconcileRunId, finalAttempt);
  }

  private async scan(runId: string, finalAttempt: boolean): Promise<void> {
    const initial = await loadRun(runId);
    if (!initial || initial.status !== 'QUEUED') return;
    const claimed = await prisma.projectionReconcileRun.updateMany({
      where: { id: runId, status: 'QUEUED' },
      data: {
        status: 'SCANNING',
        scanStartedAt: new Date(),
        scanEndedAt: null,
        complete: false,
        invalidReason: null,
      },
    });
    if (!claimed.count) return;

    let client: Client | undefined;
    try {
      client = await this.runtime.connect(
        this.runtime.decryptPostgres(initial.projection.source.encryptedConfig),
      );
      const run = await this.assertBoundRun(runId, 'SCANNING');
      const projection = projectionConfigSchema.parse(
        run.projectionVersion.config,
      );
      await this.runtime.assertVersionAndSchema(
        client,
        run.projectionVersion.configHash,
        run.schemaFingerprint,
        projection,
      );
      await prisma.projectionReconcileCandidate.deleteMany({
        where: { reconcileRunId: run.id },
      });
      await this.seedCandidates(run);

      const hmacKey = Buffer.from(
        config.APP_HMAC_KEY ?? config.APP_ENCRYPTION_KEY,
        'base64',
      );
      let after: unknown;
      let rootCount = 0;
      let manifest = createHash('sha256')
        .update('osc:projection-reconcile-manifest:v1')
        .digest('hex');

      while (true) {
        await this.assertBoundRun(runId, 'SCANNING');
        await client.query(
          'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        let roots: Array<Record<string, unknown>>;
        let eligible: Array<Record<string, unknown>>;
        let rowsByRelation: Map<
          string,
          Map<string, Array<Record<string, unknown>>>
        >;
        try {
          await client.query(
            `SET LOCAL statement_timeout = '${projection.limits.queryTimeoutMs}ms'`,
          );
          roots = await this.rootPage(client, projection, after);
          eligible = projection.root.eligibility
            ? roots.filter(
                (row) =>
                  row[projection.root.eligibility!.deletedAtIsNull] === null,
              )
            : roots;
          rowsByRelation = eligible.length
            ? await this.runtime.relationRows(client, projection, eligible)
            : new Map();
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
        if (!roots.length) break;

        const composition = composeProjectionDocuments(
          projection,
          eligible,
          rowsByRelation,
        );
        if (
          composition.diagnostics.some(
            (diagnostic) => diagnostic.code !== 'REQUIRED_RELATION_MISSING',
          ) ||
          composition.states.some(
            (state) =>
              state.terminalState !== 'COMPOSED' &&
              !composition.diagnostics.some(
                (diagnostic) =>
                  diagnostic.root === state.documentId &&
                  diagnostic.code === 'REQUIRED_RELATION_MISSING',
              ),
          )
        ) {
          throw new Error('RECONCILIATION_COMPOSITION_FAILED');
        }

        const rootHmacs = eligible.map((root) =>
          protectedKeyHmac(
            projection.root.pk.map((column) => keyPart(root[column])),
            hmacKey,
          ),
        );
        const [storedStates, storedEdges] = await Promise.all([
          prisma.projectionDocumentState.findMany({
            where: {
              projectionId: run.projectionId,
              projectionVersionId: run.projectionVersionId,
              rootKeyHmac: { in: rootHmacs },
            },
          }),
          prisma.projectionDependencyEdge.findMany({
            where: {
              projectionId: run.projectionId,
              projectionVersionId: run.projectionVersionId,
              rootKeyHmac: { in: rootHmacs },
              removedAt: null,
            },
            select: {
              rootKeyHmac: true,
              relationId: true,
              relatedKeyHmac: true,
            },
          }),
        ]);
        const statesByRoot = new Map(
          storedStates.map((state) => [state.rootKeyHmac, state]),
        );
        const edgesByRoot = new Map<string, string[]>();
        for (const edge of storedEdges) {
          const values = edgesByRoot.get(edge.rootKeyHmac) ?? [];
          values.push(`${edge.relationId}:${edge.relatedKeyHmac}`);
          edgesByRoot.set(edge.rootKeyHmac, values);
        }

        await prisma.$transaction(async (transaction) => {
          for (const state of composition.states) {
            const rootKeyHmac = protectedKeyHmac(state.rootKeyParts, hmacKey);
            if (state.terminalState !== 'COMPOSED') {
              await transaction.projectionReconcileCandidate.updateMany({
                where: { reconcileRunId: run.id, rootKeyHmac },
                data: { reason: 'REQUIRED_RELATION_MISSING' },
              });
              manifest = createHash('sha256')
                .update(manifest)
                .update('\n')
                .update(rootKeyHmac)
                .update(':REQUIRED_RELATION_MISSING')
                .digest('hex');
              continue;
            }
            await transaction.projectionReconcileCandidate.deleteMany({
              where: { reconcileRunId: run.id, rootKeyHmac },
            });
            const currentEdges = projectionDependencyKeys(
              projection,
              rowsByRelation,
              state.rootKeyHash,
            )
              .map(
                (dependency) =>
                  `${dependency.relationId}:${protectedKeyHmac(dependency.keyParts, hmacKey)}`,
              )
              .sort();
            const stored = statesByRoot.get(rootKeyHmac);
            const previousEdges = (edgesByRoot.get(rootKeyHmac) ?? []).sort();
            const drifted =
              !stored ||
              stored.terminalState !== 'IMPORTED' ||
              stored.activeGenerationId !== run.projectionGenerationId ||
              stored.canonicalHash !== state.canonicalHash ||
              stableJson(previousEdges) !== stableJson(currentEdges);
            if (drifted) {
              await transaction.projectionDirtyRoot.upsert({
                where: {
                  projectionId_projectionVersionId_rootKeyHmac: {
                    projectionId: run.projectionId,
                    projectionVersionId: run.projectionVersionId,
                    rootKeyHmac,
                  },
                },
                create: {
                  projectionId: run.projectionId,
                  projectionVersionId: run.projectionVersionId,
                  rootKeyHmac,
                  rootKeyCiphertext: this.runtime.encryptRootKey(
                    state.rootKeyParts,
                  ),
                  reason: 'RECONCILIATION_DRIFT',
                },
                update: {
                  rootKeyCiphertext: this.runtime.encryptRootKey(
                    state.rootKeyParts,
                  ),
                  reason: 'RECONCILIATION_DRIFT',
                  status: 'PENDING',
                  leaseUntil: null,
                  lastErrorCode: null,
                },
              });
            }
            manifest = createHash('sha256')
              .update(manifest)
              .update('\n')
              .update(rootKeyHmac)
              .update(':')
              .update(state.canonicalHash ?? '')
              .update(':')
              .update(
                createHash('sha256')
                  .update(stableJson(currentEdges))
                  .digest('hex'),
              )
              .digest('hex');
          }
        });
        rootCount += eligible.length;
        after = roots.at(-1)?.[projection.root.pk[0]!];
        if (roots.length < projection.limits.batchRoots) break;
      }

      await this.runtime.assertVersionAndSchema(
        client,
        run.projectionVersion.configHash,
        run.schemaFingerprint,
        projection,
      );
      await this.sync.process(
        run.projectionId,
        run.projectionVersionId,
        run.projectionGeneration!.fencingToken.toString(),
      );
      await this.assertBoundRun(runId, 'SCANNING');

      await prisma.projectionReconcileCandidate.updateMany({
        where: {
          reconcileRunId: run.id,
          state: 'PROPOSED',
          reason: 'ROOT_NOT_SEEN',
        },
        data: { reason: 'ROOT_ABSENT_OR_INELIGIBLE' },
      });
      const candidates = await prisma.projectionReconcileCandidate.findMany({
        where: { reconcileRunId: run.id, state: 'PROPOSED' },
        select: { rootKeyHmac: true, documentId: true, reason: true },
        orderBy: [{ rootKeyHmac: 'asc' }, { documentId: 'asc' }],
      });
      const candidateSetDigest = projectionCandidateSetDigest(candidates);
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
      const token = projectionReconcileToken(
        {
          runId: run.id,
          projectionVersionId: run.projectionVersionId,
          activeIndexGenerationId: run.activeIndexGenerationId,
          candidateSetDigest,
          expectedCount: candidates.length,
          expiresAt: expiresAt.toISOString(),
        },
        hmacKey,
      );
      await prisma.projectionReconcileRun.update({
        where: { id: run.id },
        data: {
          status: candidates.length ? 'AWAITING_CONFIRMATION' : 'COMPLETE',
          complete: true,
          scanEndedAt: new Date(),
          manifestDigest: manifest,
          candidateSetDigest,
          expectedCount: candidates.length,
          rootCount,
          tokenHash: candidates.length
            ? projectionReconcileTokenHash(token)
            : null,
          expiresAt: candidates.length ? expiresAt : null,
        },
      });
      this.logger.log(
        JSON.stringify({
          event: 'projection_reconciliation_scan_completed',
          runId: run.id,
          projectionId: run.projectionId,
          rootCount,
          candidateCount: candidates.length,
          manifestDigest: manifest,
          durationMs: run.scanStartedAt
            ? Date.now() - run.scanStartedAt.getTime()
            : null,
        }),
      );
    } catch (error) {
      const code = safeErrorCode(error, 'RECONCILIATION_SCAN_FAILED');
      await prisma.projectionReconcileCandidate.deleteMany({
        where: { reconcileRunId: runId },
      });
      await prisma.projectionReconcileRun.updateMany({
        where: { id: runId, status: 'SCANNING' },
        data: finalAttempt
          ? {
              status: 'INVALID',
              complete: false,
              scanEndedAt: new Date(),
              invalidReason: code,
            }
          : {
              status: 'QUEUED',
              complete: false,
              scanStartedAt: null,
              invalidReason: code,
            },
      });
      this.logger.error(`Projection reconciliation ${runId} failed: ${code}`);
      throw error;
    } finally {
      await client?.end().catch(() => undefined);
    }
  }

  private async execute(runId: string, finalAttempt: boolean): Promise<void> {
    const initial = await this.assertBoundRun(runId, 'EXECUTING');
    const projection = projectionConfigSchema.parse(
      initial.projectionVersion.config,
    );
    let client: Client | undefined;
    try {
      client = await this.runtime.connect(
        this.runtime.decryptPostgres(initial.projection.source.encryptedConfig),
      );
      await this.runtime.assertVersionAndSchema(
        client,
        initial.projectionVersion.configHash,
        initial.schemaFingerprint,
        projection,
      );
      const candidates = await prisma.projectionReconcileCandidate.findMany({
        where: { reconcileRunId: runId },
        orderBy: { rootKeyHmac: 'asc' },
      });
      const digest = projectionCandidateSetDigest(candidates);
      if (
        digest !== initial.candidateSetDigest ||
        candidates.length !== initial.expectedCount
      ) {
        throw new Error('RECONCILIATION_CANDIDATE_DRIFT');
      }

      for (const candidate of candidates) {
        if (candidate.state === 'EXECUTED') continue;
        const rows = await selectRoot(
          client,
          projection,
          this.runtime.decryptRootKey(candidate.rootKeyCiphertext),
        );
        const eligibleRoots = rows.filter((row) =>
          projection.root.eligibility
            ? row[projection.root.eligibility.deletedAtIsNull] === null
            : true,
        );
        if (!eligibleRoots.length) continue;
        if (candidate.reason !== 'REQUIRED_RELATION_MISSING') {
          throw new Error('RECONCILIATION_CANDIDATE_RETURNED');
        }
        const rowsByRelation = await this.runtime.relationRows(
          client,
          projection,
          eligibleRoots,
        );
        const composition = composeProjectionDocuments(
          projection,
          eligibleRoots,
          rowsByRelation,
        );
        const stillMissingRequired =
          composition.states.length === 1 &&
          composition.states[0]?.terminalState === 'FAILED' &&
          composition.diagnostics.length === 1 &&
          composition.diagnostics[0]?.code === 'REQUIRED_RELATION_MISSING';
        if (!stillMissingRequired) {
          throw new Error('RECONCILIATION_CANDIDATE_RETURNED');
        }
      }
      await this.runtime.assertVersionAndSchema(
        client,
        initial.projectionVersion.configHash,
        initial.schemaFingerprint,
        projection,
      );

      const connection =
        initial.projection.searchIndex.project.typesenseConnection;
      if (!connection) throw new Error('TYPESENSE_UNAVAILABLE');
      const credentials = {
        endpoint: connection.endpoint,
        apiKey: this.runtime.decryptSecret(connection.encryptedApiKey),
      };
      for (const candidate of candidates) {
        if (candidate.state === 'EXECUTED') continue;
        await this.assertBoundRun(runId, 'EXECUTING');
        await tsDelete(
          credentials,
          `/collections/${encodeURIComponent(initial.activeIndexGeneration.physicalCollection)}/documents/${encodeURIComponent(candidate.documentId)}`,
        );
        await prisma.$transaction(async (transaction) => {
          const changed =
            await transaction.projectionReconcileCandidate.updateMany({
              where: { id: candidate.id, state: 'CONFIRMED' },
              data: { state: 'EXECUTED', executedAt: new Date() },
            });
          if (!changed.count) return;
          await transaction.projectionDocumentState.updateMany({
            where: {
              projectionId: initial.projectionId,
              projectionVersionId: initial.projectionVersionId,
              rootKeyHmac: candidate.rootKeyHmac,
            },
            data: { terminalState: 'DELETED', activeGenerationId: null },
          });
          await transaction.projectionDependencyEdge.updateMany({
            where: {
              projectionId: initial.projectionId,
              projectionVersionId: initial.projectionVersionId,
              rootKeyHmac: candidate.rootKeyHmac,
              removedAt: null,
            },
            data: {
              removedAt: new Date(),
              retainUntil: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            },
          });
          await transaction.indexGeneration.update({
            where: { id: initial.activeIndexGenerationId },
            data: { recordCount: { decrement: 1 } },
          });
        });
      }
      await prisma.projectionReconcileRun.updateMany({
        where: { id: runId, status: 'EXECUTING' },
        data: { status: 'EXECUTED', executedAt: new Date() },
      });
      this.logger.log(
        JSON.stringify({
          event: 'projection_reconciliation_execution_completed',
          runId,
          projectionId: initial.projectionId,
          deletedCount: candidates.length,
        }),
      );
    } catch (error) {
      if (finalAttempt) await this.invalidate(runId, safeErrorCode(error));
      this.logger.error(
        `Projection reconciliation execution ${runId} failed: ${safeErrorCode(error)}`,
      );
      throw error;
    } finally {
      await client?.end().catch(() => undefined);
    }
  }

  private async seedCandidates(run: LoadedRun): Promise<void> {
    let cursor: string | undefined;
    while (true) {
      const states = await prisma.projectionDocumentState.findMany({
        where: {
          projectionId: run.projectionId,
          projectionVersionId: run.projectionVersionId,
          terminalState: 'IMPORTED',
        },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!states.length) break;
      await prisma.projectionReconcileCandidate.createMany({
        data: states.map((state) => ({
          reconcileRunId: run.id,
          rootKeyHmac: state.rootKeyHmac,
          rootKeyCiphertext: state.rootKeyCiphertext,
          documentId: state.documentId,
          reason: 'ROOT_NOT_SEEN',
        })),
        skipDuplicates: true,
      });
      cursor = states.at(-1)!.id;
      if (states.length < 500) break;
    }
  }

  private async rootPage(
    client: Client,
    projection: ProjectionConfig,
    after: unknown,
  ): Promise<Array<Record<string, unknown>>> {
    const columns = rootColumns(projection);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (after !== undefined) {
      values.push(after);
      conditions.push(`${quote(projection.root.pk[0]!)} > $1`);
    }
    values.push(projection.limits.batchRoots);
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${columns.map(quote).join(', ')} FROM ${quote(projection.root.schema)}.${quote(projection.root.table)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${quote(projection.root.pk[0]!)} ASC LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  }

  private async assertBoundRun(
    runId: string,
    status: 'SCANNING' | 'EXECUTING',
  ): Promise<LoadedRun> {
    const run = await loadRun(runId);
    const generation = run?.projection.generations[0];
    if (
      !run ||
      run.status !== status ||
      !run.projectionGeneration ||
      !generation ||
      run.projection.status !== 'PUBLISHED' ||
      run.projection.activeVersionId !== run.projectionVersionId ||
      generation.id !== run.projectionGenerationId ||
      generation.indexGenerationId !== run.activeIndexGenerationId ||
      generation.fencingToken !== run.projectionGeneration.fencingToken ||
      run.projectionVersion.schemaFingerprint !== run.schemaFingerprint ||
      (status === 'EXECUTING' &&
        (!run.complete || !run.expiresAt || run.expiresAt <= new Date()))
    ) {
      if (run && ['SCANNING', 'EXECUTING'].includes(run.status)) {
        await this.invalidate(run.id, 'RECONCILIATION_BINDING_INVALID');
      }
      throw new Error('RECONCILIATION_BINDING_INVALID');
    }
    return run;
  }

  private async invalidate(runId: string, reason: string): Promise<void> {
    await prisma.$transaction([
      prisma.projectionReconcileRun.updateMany({
        where: { id: runId, status: { notIn: ['EXECUTED', 'INVALID'] } },
        data: { status: 'INVALID', invalidReason: reason },
      }),
      prisma.projectionReconcileCandidate.updateMany({
        where: { reconcileRunId: runId, state: { not: 'EXECUTED' } },
        data: { state: 'INVALID' },
      }),
    ]);
  }
}

function rootColumns(projection: ProjectionConfig): string[] {
  const columns = new Set(projection.root.pk);
  if (projection.root.eligibility)
    columns.add(projection.root.eligibility.deletedAtIsNull);
  for (const field of projection.fields) {
    for (const path of [
      field.path,
      ...(field.concatPaths ?? []),
      ...(field.orderBy ?? []).map((item) => item.path),
    ]) {
      const [relation, column] = path.split('.');
      if (relation === 'root' && column) columns.add(column);
    }
  }
  projection.relations
    .filter((relation) => relation.from.relation === 'root')
    .forEach((relation) =>
      relation.from.columns.forEach((column) => columns.add(column)),
    );
  return [...columns];
}

async function selectRoot(
  client: Client,
  projection: ProjectionConfig,
  key: CanonicalKeyPart[],
) {
  if (key.length !== projection.root.pk.length)
    throw new Error('INVALID_ROOT_KEY');
  const values = key.map((part) =>
    typeof part === 'bigint' ? part.toString() : part,
  );
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${rootColumns(projection).map(quote).join(', ')} FROM ${quote(projection.root.schema)}.${quote(projection.root.table)} WHERE ${projection.root.pk.map((column, index) => `${quote(column)} = $${index + 1}`).join(' AND ')} LIMIT 1`,
    values,
  );
  return result.rows;
}

function keyPart(value: unknown): CanonicalKeyPart {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    Buffer.isBuffer(value)
  )
    return value;
  throw new Error('INVALID_ROOT_KEY');
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function safeErrorCode(
  error: unknown,
  fallback = 'RECONCILIATION_EXECUTION_FAILED',
): string {
  const value =
    error instanceof Error ? (error.message.split(':')[0] ?? '') : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : fallback;
}
