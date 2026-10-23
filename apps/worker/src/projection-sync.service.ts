import { Inject, Injectable, Logger } from '@nestjs/common';
import { workerEnvironmentSchema } from '@osc/contracts';
import { createPrismaClient } from '@osc/db';
import {
  composeProjectionDocuments,
  encodeCanonicalKey,
  projectionConfigSchema,
  projectionDependencyKeys,
  protectedKeyHmac,
  stableJson,
  type CanonicalKeyPart,
  type ProjectionConfig,
} from '@osc/ingestion';
import type { Client } from 'pg';
import { createHash } from 'node:crypto';

import {
  ProjectionSnapshotService,
  tsImport,
} from './projection-snapshot.service.js';

const config = workerEnvironmentSchema.parse(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);

async function loadProjection(id: string) {
  return prisma.sourceProjection.findUnique({
    where: { id },
    include: {
      activeVersion: true,
      source: true,
      searchIndex: {
        include: { project: { include: { typesenseConnection: true } } },
      },
      generations: {
        where: { status: 'ACTIVE' },
        include: { indexGeneration: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
}

type ActiveProjection = NonNullable<Awaited<ReturnType<typeof loadProjection>>>;
type ProjectionRelation = ProjectionConfig['relations'][number];

interface TrackingTarget {
  relationId: string;
  schema: string;
  table: string;
  updatedAt: string;
  key: string[];
  overlapSeconds: number;
  identityColumns: string[];
  relation?: ProjectionRelation;
}

@Injectable()
export class ProjectionSyncService {
  private readonly logger = new Logger(ProjectionSyncService.name);

  constructor(
    @Inject(ProjectionSnapshotService)
    private readonly runtime: ProjectionSnapshotService,
  ) {}

  async process(
    projectionId: string,
    projectionVersionId: string,
    expectedFence: string,
  ): Promise<void> {
    if (!config.ENABLE_RELATIONAL_PROJECTIONS) return;
    const projection = await loadProjection(projectionId);
    const generation = projection?.generations[0];
    if (
      !projection ||
      projection.status !== 'PUBLISHED' ||
      projection.activeVersionId !== projectionVersionId ||
      !projection.activeVersion ||
      !generation ||
      generation.fencingToken.toString() !== expectedFence
    )
      return;
    const projectionConfig = projectionConfigSchema.parse(
      projection.activeVersion.config,
    );
    const client = await this.runtime.connect(
      this.runtime.decryptPostgres(projection.source.encryptedConfig),
    );
    try {
      await this.runtime.assertVersionAndSchema(
        client,
        projection.activeVersion.configHash,
        projection.activeVersion.schemaFingerprint,
        projectionConfig,
      );
      const targets = trackingTargets(projectionConfig);
      for (const target of targets) {
        await this.assertActive(projection, generation.fencingToken);
        await this.scanTarget(client, projection, projectionConfig, target);
      }
      await this.rebuildDirtyRoots(
        client,
        projection,
        projectionConfig,
        generation,
      );
      await prisma.dataSource.update({
        where: { id: projection.sourceId },
        data: { lastSyncAt: new Date(), lastError: null, state: 'READY' },
      });
    } catch (error) {
      const code = safeErrorCode(error);
      await prisma.dataSource.update({
        where: { id: projection.sourceId },
        data: { lastError: code, state: 'ERROR', errorCount: { increment: 1 } },
      });
      this.logger.error(`Projection sync ${projection.id} failed: ${code}`);
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async scanTarget(
    client: Client,
    projection: ActiveProjection,
    projectionConfig: ProjectionConfig,
    target: TrackingTarget,
  ) {
    const versionId = projection.activeVersionId!;
    const cursor = await prisma.relationScanCursor.upsert({
      where: {
        projectionId_projectionVersionId_relationId: {
          projectionId: projection.id,
          projectionVersionId: versionId,
          relationId: target.relationId,
        },
      },
      create: {
        projectionId: projection.id,
        projectionVersionId: versionId,
        relationId: target.relationId,
        overlapSeconds: target.overlapSeconds,
      },
      update: {},
    });
    const high = await client.query<{ high: Date }>(
      'SELECT CURRENT_TIMESTAMP AS high',
    );
    const highWatermark = high.rows[0]!.high;
    let pageTime = cursor.cursorTime
      ? new Date(cursor.cursorTime.getTime() - target.overlapSeconds * 1_000)
      : undefined;
    let pageTuple: unknown[] = [];
    let firstPage = true;
    while (true) {
      const rows = await this.changePage(
        client,
        target,
        highWatermark,
        pageTime,
        pageTuple,
        projectionConfig.limits.batchRoots,
      );
      if (!rows.length) break;
      for (const row of rows) {
        await this.recordChange(
          client,
          projection,
          projectionConfig,
          target,
          row,
        );
      }
      const last = rows.at(-1)!;
      pageTime = new Date(String(last[target.updatedAt]));
      pageTuple = target.key.map((column) => last[column]);
      await prisma.relationScanCursor.update({
        where: { id: cursor.id },
        data: {
          cursorTime: pageTime,
          cursorTuple: json(pageTuple),
          checkpointVersion: { increment: 1 },
          completedAt: null,
        },
      });
      firstPage = false;
      if (rows.length < projectionConfig.limits.batchRoots) break;
    }
    await prisma.relationScanCursor.update({
      where: { id: cursor.id },
      data: {
        ...(firstPage && cursor.cursorTime === null
          ? { cursorTime: highWatermark, cursorTuple: [] }
          : {}),
        completedAt: new Date(),
      },
    });
  }

  private async changePage(
    client: Client,
    target: TrackingTarget,
    highWatermark: Date,
    afterTime: Date | undefined,
    afterTuple: unknown[],
    limit: number,
  ) {
    const selected = new Set([
      target.updatedAt,
      ...target.key,
      ...target.identityColumns,
      ...(target.relation?.to.columns ?? []),
    ]);
    const values: unknown[] = [highWatermark];
    const conditions = [`${quote(target.updatedAt)} <= $1`];
    if (afterTime) {
      values.push(afterTime);
      if (afterTuple.length === target.key.length) {
        const timeParameter = values.length;
        const tupleParameters = afterTuple.map((value) => {
          values.push(value);
          return `$${values.length}`;
        });
        conditions.push(
          `(${quote(target.updatedAt)} > $${timeParameter} OR (${quote(target.updatedAt)} = $${timeParameter} AND ROW(${target.key.map(quote).join(', ')}) > ROW(${tupleParameters.join(', ')})))`,
        );
      } else {
        conditions.push(`${quote(target.updatedAt)} >= $${values.length}`);
      }
    }
    values.push(limit);
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${[...selected].map(quote).join(', ')} FROM ${quote(target.schema)}.${quote(target.table)} WHERE ${conditions.join(' AND ')} ORDER BY ${quote(target.updatedAt)} ASC, ${target.key.map(quote).join(', ')} ASC LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  }

  private async recordChange(
    client: Client,
    projection: ActiveProjection,
    projectionConfig: ProjectionConfig,
    target: TrackingTarget,
    row: Record<string, unknown>,
  ) {
    const versionId = projection.activeVersionId!;
    const relationKey = target.key.map((column) => keyPart(row[column]));
    const hmacKey = Buffer.from(
      config.APP_HMAC_KEY ?? config.APP_ENCRYPTION_KEY,
      'base64',
    );
    const relationKeyHmac = protectedKeyHmac(relationKey, hmacKey);
    const occurredAt = new Date(String(row[target.updatedAt]));
    const dedupeKey = createHash('sha256')
      .update(projection.id)
      .update(versionId)
      .update(target.relationId)
      .update(encodeCanonicalKey(relationKey))
      .update(occurredAt.toISOString())
      .digest('hex');
    const event = await prisma.projectionChangeEvent.upsert({
      where: { dedupeKey },
      create: {
        projectionId: projection.id,
        projectionVersionId: versionId,
        relationId: target.relationId,
        relationKeyHmac,
        relationKeyCiphertext: this.runtime.encryptRelationKey(relationKey),
        dedupeKey,
        occurredAt,
      },
      update: {},
    });
    if (event.status === 'COMPLETED') return;
    const roots = new Map<string, CanonicalKeyPart[]>();
    if (!target.relation) {
      const parts = projectionConfig.root.pk.map((column) =>
        keyPart(row[column]),
      );
      roots.set(protectedKeyHmac(parts, hmacKey), parts);
    } else {
      const historical = await prisma.projectionDependencyEdge.findMany({
        where: {
          projectionId: projection.id,
          projectionVersionId: versionId,
          relationId: target.relation.id,
          relatedKeyHmac: relationKeyHmac,
        },
        select: { rootKeyHmac: true, rootKeyCiphertext: true },
      });
      for (const edge of historical) {
        roots.set(
          edge.rootKeyHmac,
          this.runtime.decryptRootKey(edge.rootKeyCiphertext),
        );
      }
      for (const parts of await this.resolveCurrentRoots(
        client,
        projectionConfig,
        target.relation,
        [row],
      )) {
        roots.set(protectedKeyHmac(parts, hmacKey), parts);
      }
    }
    await prisma.$transaction(async (transaction) => {
      for (const [rootKeyHmac, parts] of roots) {
        await transaction.projectionDirtyRoot.upsert({
          where: {
            projectionId_projectionVersionId_rootKeyHmac: {
              projectionId: projection.id,
              projectionVersionId: versionId,
              rootKeyHmac,
            },
          },
          create: {
            projectionId: projection.id,
            projectionVersionId: versionId,
            rootKeyHmac,
            rootKeyCiphertext: this.runtime.encryptRootKey(parts),
            reason: `CHANGE:${target.relationId}`,
          },
          update: {
            rootKeyCiphertext: this.runtime.encryptRootKey(parts),
            reason: `CHANGE:${target.relationId}`,
            status: 'PENDING',
            leaseUntil: null,
            lastErrorCode: null,
          },
        });
      }
      await transaction.projectionChangeEvent.update({
        where: { id: event.id },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });
    });
  }

  private async resolveCurrentRoots(
    client: Client,
    projection: ProjectionConfig,
    relation: ProjectionRelation,
    changedRows: Array<Record<string, unknown>>,
  ): Promise<CanonicalKeyPart[][]> {
    let currentRelation = relation;
    let rows = changedRows;
    const relations = new Map(
      projection.relations.map((item) => [item.id, item]),
    );
    while (true) {
      const joinValues = uniqueTuples(
        rows.map((row) =>
          currentRelation.to.columns.map((column) => row[column]),
        ),
      );
      if (!joinValues.length) return [];
      if (currentRelation.from.relation === 'root') {
        const rootRows = await selectByTuples(
          client,
          projection.root.schema,
          projection.root.table,
          projection.root.pk,
          currentRelation.from.columns,
          joinValues,
        );
        return rootRows.map((row) =>
          projection.root.pk.map((column) => keyPart(row[column])),
        );
      }
      const parent = relations.get(currentRelation.from.relation);
      if (!parent) throw new Error('INVALID_RELATION');
      rows = await selectByTuples(
        client,
        parent.to.schema,
        parent.to.table,
        parent.to.columns,
        currentRelation.from.columns,
        joinValues,
      );
      currentRelation = parent;
    }
  }

  private async rebuildDirtyRoots(
    client: Client,
    projection: ActiveProjection,
    projectionConfig: ProjectionConfig,
    generation: ActiveProjection['generations'][number],
  ) {
    const connection = projection.searchIndex.project.typesenseConnection;
    if (!connection) throw new Error('TYPESENSE_UNAVAILABLE');
    const credentials = {
      endpoint: connection.endpoint,
      apiKey: this.runtime.decryptSecret(connection.encryptedApiKey),
    };
    while (true) {
      const pending = await prisma.projectionDirtyRoot.findMany({
        where: {
          projectionId: projection.id,
          projectionVersionId: projection.activeVersionId!,
          OR: [
            { status: 'PENDING' },
            { status: 'LEASED', leaseUntil: { lte: new Date() } },
          ],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: projectionConfig.limits.batchRoots,
      });
      if (!pending.length) break;
      const leased = [];
      for (const item of pending) {
        const claim = await prisma.projectionDirtyRoot.updateMany({
          where: {
            id: item.id,
            OR: [
              { status: 'PENDING' },
              { status: 'LEASED', leaseUntil: { lte: new Date() } },
            ],
          },
          data: {
            status: 'LEASED',
            attempts: { increment: 1 },
            leaseUntil: new Date(Date.now() + 60_000),
            fencingToken: generation.fencingToken,
          },
        });
        if (claim.count) leased.push(item);
      }
      if (!leased.length) break;
      await client.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      let roots: Array<Record<string, unknown>>;
      let rowsByRelation;
      try {
        const selectedRoots = await selectByTuples(
          client,
          projectionConfig.root.schema,
          projectionConfig.root.table,
          rootColumns(projectionConfig),
          projectionConfig.root.pk,
          leased.map((item) =>
            this.runtime.decryptRootKey(item.rootKeyCiphertext),
          ),
        );
        roots = projectionConfig.root.eligibility
          ? selectedRoots.filter(
              (row) =>
                row[projectionConfig.root.eligibility!.deletedAtIsNull] ===
                null,
            )
          : selectedRoots;
        rowsByRelation = roots.length
          ? await this.runtime.relationRows(client, projectionConfig, roots)
          : new Map();
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      const found = new Set(
        roots.map((row) =>
          stableJson(projectionConfig.root.pk.map((column) => row[column])),
        ),
      );
      for (const item of leased) {
        const parts = this.runtime.decryptRootKey(item.rootKeyCiphertext);
        if (!found.has(stableJson(parts))) {
          await prisma.projectionDirtyRoot.update({
            where: { id: item.id },
            data: {
              status: 'FAILED',
              leaseUntil: null,
              lastErrorCode: 'ROOT_ABSENCE_REQUIRES_RECONCILIATION',
            },
          });
        }
      }
      if (!roots.length) continue;
      const composition = composeProjectionDocuments(
        projectionConfig,
        roots,
        rowsByRelation,
      );
      const results = composition.documents.length
        ? await tsImport(
            credentials,
            generation.indexGeneration.physicalCollection,
            composition.documents,
          )
        : [];
      const failedIds = new Set(
        results.flatMap((result, index) =>
          result.success
            ? []
            : [String(composition.documents[index]?.id ?? 'unknown')],
        ),
      );
      const byRoot = new Map(
        leased.map((item) => [
          stableJson(this.runtime.decryptRootKey(item.rootKeyCiphertext)),
          item,
        ]),
      );
      const hmacKey = Buffer.from(
        config.APP_HMAC_KEY ?? config.APP_ENCRYPTION_KEY,
        'base64',
      );
      await prisma.$transaction(async (transaction) => {
        let newDocumentCount = 0;
        for (const state of composition.states) {
          const dirty = byRoot.get(state.rootKeyHash);
          if (!dirty) continue;
          const imported =
            state.terminalState === 'COMPOSED' &&
            !failedIds.has(state.documentId);
          if (!imported) {
            await transaction.projectionDirtyRoot.update({
              where: { id: dirty.id },
              data: {
                status: 'FAILED',
                leaseUntil: null,
                lastErrorCode: 'INCREMENTAL_COMPOSITION_FAILED',
              },
            });
            continue;
          }
          const rootKeyHmac = protectedKeyHmac(state.rootKeyParts, hmacKey);
          const rootKeyCiphertext = this.runtime.encryptRootKey(
            state.rootKeyParts,
          );
          const existingState =
            await transaction.projectionDocumentState.findUnique({
              where: {
                projectionId_projectionVersionId_rootKeyHmac: {
                  projectionId: projection.id,
                  projectionVersionId: projection.activeVersionId!,
                  rootKeyHmac,
                },
              },
              select: { id: true, terminalState: true },
            });
          await transaction.projectionDocumentState.upsert({
            where: {
              projectionId_projectionVersionId_rootKeyHmac: {
                projectionId: projection.id,
                projectionVersionId: projection.activeVersionId!,
                rootKeyHmac,
              },
            },
            create: {
              projectionId: projection.id,
              projectionVersionId: projection.activeVersionId!,
              rootKeyHmac,
              rootKeyCiphertext,
              documentId: state.documentId,
              canonicalHash: state.canonicalHash!,
              activeGenerationId: generation.id,
              terminalState: 'IMPORTED',
            },
            update: {
              rootKeyCiphertext,
              canonicalHash: state.canonicalHash!,
              activeGenerationId: generation.id,
              terminalState: 'IMPORTED',
            },
          });
          await transaction.projectionDependencyEdge.updateMany({
            where: {
              projectionId: projection.id,
              projectionVersionId: projection.activeVersionId!,
              rootKeyHmac,
              removedAt: null,
            },
            data: {
              removedAt: new Date(),
              retainUntil: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            },
          });
          for (const dependency of projectionDependencyKeys(
            projectionConfig,
            rowsByRelation,
            state.rootKeyHash,
          )) {
            const relatedKeyHmac = protectedKeyHmac(
              dependency.keyParts,
              hmacKey,
            );
            await transaction.projectionDependencyEdge.upsert({
              where: {
                projectionId_projectionVersionId_relationId_relatedKeyHmac_rootKeyHmac:
                  {
                    projectionId: projection.id,
                    projectionVersionId: projection.activeVersionId!,
                    relationId: dependency.relationId,
                    relatedKeyHmac,
                    rootKeyHmac,
                  },
              },
              create: {
                projectionId: projection.id,
                projectionVersionId: projection.activeVersionId!,
                relationId: dependency.relationId,
                relatedKeyHmac,
                rootKeyHmac,
                rootKeyCiphertext,
                firstSeenGeneration: generation.indexGeneration.generation,
                lastSeenGeneration: generation.indexGeneration.generation,
              },
              update: {
                rootKeyCiphertext,
                lastSeenGeneration: generation.indexGeneration.generation,
                removedAt: null,
                retainUntil: null,
              },
            });
          }
          await transaction.projectionDirtyRoot.update({
            where: { id: dirty.id },
            data: {
              status: 'COMPLETED',
              leaseUntil: null,
              lastErrorCode: null,
            },
          });
          if (!existingState || existingState.terminalState === 'DELETED')
            newDocumentCount += 1;
        }
        if (newDocumentCount) {
          await transaction.indexGeneration.update({
            where: { id: generation.indexGenerationId },
            data: { recordCount: { increment: newDocumentCount } },
          });
        }
      });
    }
  }

  private async assertActive(projection: ActiveProjection, token: bigint) {
    const current = await prisma.sourceProjection.findFirst({
      where: {
        id: projection.id,
        status: 'PUBLISHED',
        activeVersionId: projection.activeVersionId,
        generations: { some: { status: 'ACTIVE', fencingToken: token } },
      },
      select: { id: true },
    });
    if (!current) throw new Error('STALE_GENERATION');
  }
}

export function trackingTargets(
  configValue: ProjectionConfig,
): TrackingTarget[] {
  const targets: TrackingTarget[] = [];
  if (configValue.root.changeTracking.mode === 'poll') {
    targets.push({
      relationId: 'root',
      schema: configValue.root.schema,
      table: configValue.root.table,
      updatedAt: configValue.root.changeTracking.updatedAt,
      key: configValue.root.changeTracking.key,
      overlapSeconds: configValue.root.changeTracking.overlapSeconds,
      identityColumns: configValue.root.pk,
    });
  }
  for (const relation of configValue.relations) {
    if (relation.changeTracking.mode !== 'poll') continue;
    targets.push({
      relationId: relation.id,
      schema: relation.to.schema,
      table: relation.to.table,
      updatedAt: relation.changeTracking.updatedAt,
      key: relation.changeTracking.key,
      overlapSeconds: relation.changeTracking.overlapSeconds,
      identityColumns: relation.to.columns,
      relation,
    });
  }
  return targets;
}

function rootColumns(configValue: ProjectionConfig) {
  const columns = new Set(configValue.root.pk);
  if (configValue.root.eligibility)
    columns.add(configValue.root.eligibility.deletedAtIsNull);
  for (const field of configValue.fields) {
    for (const path of [
      field.path,
      ...(field.concatPaths ?? []),
      ...(field.orderBy ?? []).map((item) => item.path),
    ]) {
      const [relation, column] = path.split('.');
      if (relation === 'root' && column) columns.add(column);
    }
  }
  configValue.relations
    .filter((relation) => relation.from.relation === 'root')
    .forEach((relation) =>
      relation.from.columns.forEach((column) => columns.add(column)),
    );
  return [...columns];
}

async function selectByTuples(
  client: Client,
  schema: string,
  table: string,
  selected: string[],
  columns: string[],
  tuples: unknown[][],
) {
  const valid = uniqueTuples(tuples);
  if (!valid.length) return [];
  const values: unknown[] = [];
  const predicates = valid.map(
    (tuple) =>
      `(${columns
        .map((column, index) => {
          values.push(tuple[index]);
          return `${quote(column)} = $${values.length}`;
        })
        .join(' AND ')})`,
  );
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${[...new Set([...selected, ...columns])].map(quote).join(', ')} FROM ${quote(schema)}.${quote(table)} WHERE ${predicates.join(' OR ')}`,
    values,
  );
  return result.rows;
}

function uniqueTuples(tuples: unknown[][]) {
  const values = new Map<string, unknown[]>();
  for (const tuple of tuples) {
    if (tuple.some((value) => value === null || value === undefined)) continue;
    values.set(stableJson(tuple), tuple);
  }
  return [...values.values()];
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
  throw new Error('INVALID_CHANGE_KEY');
}

function quote(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as never;
}

function safeErrorCode(error: unknown) {
  const value =
    error instanceof Error ? (error.message.split(':')[0] ?? '') : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value
    : 'PROJECTION_SYNC_FAILED';
}
