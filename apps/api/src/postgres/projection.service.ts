import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WorkspaceRole } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';
import {
  assertProjectionVersionEditable,
  projectionCandidateSetDigest,
  projectionConfigHash,
  projectionConfigSchema,
  projectionReconcileToken,
  projectionReconcileTokenHash,
  projectionReconciliationCanExecute,
  projectionSchemaFingerprint,
  validateProjectionCatalog,
  type CatalogRelation,
  type CreateProjectionRequest,
  type ProjectionConfig,
  type ProjectionMappingField,
  type ProjectionPreviewRequest,
  type ProjectionPublishRequest,
  type ProjectionReconcileConfirmRequest,
  type ProjectionVersionAction,
  type UpdateProjectionVersionRequest,
} from '@osc/ingestion';
import { createHash, timingSafeEqual } from 'node:crypto';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA } from '../infrastructure/tokens.js';
import { IngestionQueueService } from '../ingestion/ingestion-queue.service.js';
import { requireWorkspaceRole } from '../workspaces/access.js';
import { PostgresSourceService } from './postgres-source.service.js';

@Injectable()
export class ProjectionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PostgresSourceService)
    private readonly sources: PostgresSourceService,
    @Inject(IngestionQueueService)
    private readonly queue: IngestionQueueService,
  ) {}

  async list(userId: string, projectId: string) {
    await this.project(userId, projectId);
    if (!this.config.ENABLE_RELATIONAL_PROJECTIONS) {
      return { data: [], meta: { enabled: false } };
    }
    const data = await this.prisma.sourceProjection.findMany({
      where: { projectId },
      include: {
        source: { select: { id: true, name: true } },
        searchIndex: { select: { id: true, name: true } },
        activeVersion: true,
        draftVersion: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data, meta: { enabled: true } };
  }

  async get(userId: string, projectId: string, projectionId: string) {
    this.assertEnabled();
    return this.projection(userId, projectId, projectionId);
  }

  async catalog(userId: string, projectId: string, sourceId: string) {
    this.assertEnabled();
    await this.project(userId, projectId);
    const source = await this.prisma.dataSource.findFirst({
      where: { id: sourceId, projectId, type: 'POSTGRES' },
      select: { id: true, name: true },
    });
    if (!source) throw new NotFoundException('PostgreSQL source not found');
    const response = await this.sources.datasets(userId, sourceId);
    return { data: response.data, meta: { source } };
  }

  async create(
    userId: string,
    projectId: string,
    input: CreateProjectionRequest,
  ) {
    this.assertEnabled();
    const project = await this.project(userId, projectId, 'EDITOR');
    const [source, index] = await Promise.all([
      this.prisma.dataSource.findFirst({
        where: { id: input.sourceId, projectId, type: 'POSTGRES' },
      }),
      this.prisma.searchIndex.findFirst({
        where: { id: input.searchIndexId, projectId },
      }),
    ]);
    if (!source) throw new NotFoundException('PostgreSQL source not found');
    if (!index) throw new NotFoundException('Search index not found');
    const existing = await this.prisma.sourceProjection.findFirst({
      where: {
        projectId,
        OR: [{ name: input.name }, { searchIndexId: input.searchIndexId }],
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'A projection already uses this name or search index',
      );
    }
    const config = projectionConfigSchema.parse(input.config);
    const created = await this.prisma.$transaction(async (transaction) => {
      const projection = await transaction.sourceProjection.create({
        data: {
          projectId,
          sourceId: source.id,
          searchIndexId: index.id,
          name: input.name,
          createdById: userId,
        },
      });
      const version = await transaction.sourceProjectionVersion.create({
        data: {
          projectionId: projection.id,
          version: 1,
          config,
          configHash: projectionConfigHash(config),
          schemaFingerprint: null,
          createdById: userId,
        },
      });
      await transaction.sourceProjection.update({
        where: { id: projection.id },
        data: { draftVersionId: version.id },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: project.workspaceId,
          projectId,
          actorId: userId,
          action: 'source_projection.created',
          targetType: 'source_projection',
          targetId: projection.id,
          metadata: { sourceId: source.id, searchIndexId: index.id },
        },
      });
      return projection.id;
    });
    return this.projection(userId, projectId, created);
  }

  async updateVersion(
    userId: string,
    projectId: string,
    projectionId: string,
    versionId: string,
    input: UpdateProjectionVersionRequest,
  ) {
    this.assertEnabled();
    const projection = await this.projection(
      userId,
      projectId,
      projectionId,
      'EDITOR',
    );
    const version = projection.versions.find((item) => item.id === versionId);
    if (!version) throw new NotFoundException('Projection version not found');
    assertProjectionVersionEditable(version.status);
    if (version.updatedAt.toISOString() !== input.expectedUpdatedAt) {
      throw new ConflictException('Projection draft changed; reload and retry');
    }
    const config = projectionConfigSchema.parse(input.config);
    const updated = await this.prisma.sourceProjectionVersion.updateMany({
      where: { id: version.id, status: 'DRAFT', updatedAt: version.updatedAt },
      data: {
        config,
        configHash: projectionConfigHash(config),
        schemaFingerprint: null,
        validation: {},
        validatedAt: null,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Projection draft changed; reload and retry');
    }
    await this.prisma.auditLog.create({
      data: {
        workspaceId: projection.project.workspaceId,
        projectId: projection.projectId,
        actorId: userId,
        action: 'source_projection.draft_updated',
        targetType: 'source_projection',
        targetId: projection.id,
        metadata: { versionId },
      },
    });
    return this.projection(userId, projectId, projectionId);
  }

  async validate(
    userId: string,
    projectId: string,
    projectionId: string,
    input: ProjectionVersionAction,
  ) {
    this.assertEnabled();
    const projection = await this.projection(
      userId,
      projectId,
      projectionId,
      'EDITOR',
    );
    const version = projection.versions.find(
      (item) => item.id === input.versionId,
    );
    if (!version) throw new NotFoundException('Projection version not found');
    assertProjectionVersionEditable(version.status);
    const config = projectionConfigSchema.parse(version.config);
    const result = await this.validateAgainstSource(userId, projection, config);
    const now = new Date();
    await this.prisma.sourceProjectionVersion.update({
      where: { id: version.id },
      data: {
        schemaFingerprint: result.schemaFingerprint,
        validation: JSON.parse(
          JSON.stringify({
            valid: result.issues.length === 0,
            issues: result.issues,
            validatedAt: now.toISOString(),
          }),
        ),
        ...(result.issues.length === 0
          ? { status: 'VALIDATED', validatedAt: now }
          : {}),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        workspaceId: projection.project.workspaceId,
        projectId: projection.projectId,
        actorId: userId,
        action: 'source_projection.validated',
        targetType: 'source_projection',
        targetId: projection.id,
        metadata: {
          versionId: version.id,
          valid: result.issues.length === 0,
          issueCodes: [...new Set(result.issues.map((issue) => issue.code))],
        },
      },
    });
    return {
      valid: result.issues.length === 0,
      issues: result.issues,
      schemaFingerprint: result.schemaFingerprint,
    };
  }

  async preview(
    userId: string,
    projectId: string,
    projectionId: string,
    input: ProjectionPreviewRequest,
  ) {
    this.assertEnabled();
    const projection = await this.projection(
      userId,
      projectId,
      projectionId,
      'EDITOR',
    );
    const version = projection.versions.find(
      (item) => item.id === input.versionId,
    );
    if (!version) throw new NotFoundException('Projection version not found');
    if (version.status !== 'VALIDATED') {
      throw new BadRequestException('Projection version must be validated');
    }
    const config = projectionConfigSchema.parse(version.config);
    const validation = await this.validateAgainstSource(
      userId,
      projection,
      config,
    );
    if (
      validation.issues.length ||
      validation.schemaFingerprint !== version.schemaFingerprint
    ) {
      throw new BadRequestException('SCHEMA_DRIFT');
    }
    return this.sources.previewProjection(
      userId,
      projection.sourceId,
      config,
      input.limit,
    );
  }

  async publish(
    userId: string,
    projectId: string,
    projectionId: string,
    idempotencyKey: string,
    input: ProjectionPublishRequest,
  ) {
    this.assertEnabled();
    const projection = await this.projection(
      userId,
      projectId,
      projectionId,
      'EDITOR',
    );
    const version = projection.versions.find(
      (item) => item.id === input.versionId,
    );
    if (!version) throw new NotFoundException('Projection version not found');
    const idempotent = await this.prisma.projectionGeneration.findUnique({
      where: { idempotencyKey },
      include: { indexGeneration: true },
    });
    if (idempotent) {
      if (
        idempotent.projectionId !== projection.id ||
        idempotent.projectionVersionId !== version.id
      ) {
        throw new ConflictException('Idempotency key is already in use');
      }
      return this.generationResult(idempotent);
    }
    if (
      version.status !== 'VALIDATED' ||
      projection.draftVersionId !== version.id ||
      !version.schemaFingerprint
    ) {
      throw new BadRequestException('A validated draft version is required');
    }
    const activeBuild = await this.prisma.projectionGeneration.findFirst({
      where: {
        projectionId,
        status: {
          in: ['QUEUED', 'RUNNING', 'READY_TO_PROMOTE', 'PROMOTING'],
        },
      },
      select: { id: true },
    });
    if (activeBuild) {
      throw new ConflictException('A projection build is already active');
    }
    const config = projectionConfigSchema.parse(version.config);
    const validation = await this.validateAgainstSource(
      userId,
      projection,
      config,
    );
    if (
      validation.issues.length ||
      validation.schemaFingerprint !== version.schemaFingerprint
    ) {
      throw new BadRequestException('SCHEMA_DRIFT');
    }
    const [latestIndex, latestFence] = await Promise.all([
      this.prisma.indexGeneration.aggregate({
        where: { searchIndexId: projection.searchIndexId },
        _max: { generation: true },
      }),
      this.prisma.projectionGeneration.aggregate({
        where: { projectionId },
        _max: { fencingToken: true },
      }),
    ]);
    const generationNumber = (latestIndex._max.generation ?? 0) + 1;
    const fencingToken = (latestFence._max.fencingToken ?? 0n) + 1n;
    const generation = await this.prisma.$transaction(async (transaction) => {
      const indexGeneration = await transaction.indexGeneration.create({
        data: {
          searchIndexId: projection.searchIndexId,
          generation: generationNumber,
          physicalCollection: `${projection.searchIndex.alias}__build_${generationNumber}`,
        },
      });
      const created = await transaction.projectionGeneration.create({
        data: {
          projectionId,
          projectionVersionId: version.id,
          indexGenerationId: indexGeneration.id,
          idempotencyKey,
          fencingToken,
          counters: {
            scanned: 0,
            imported: 0,
            failed: 0,
            eventualConsistencyAccepted: input.eventualConsistencyAccepted,
          },
        },
        include: { indexGeneration: true },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: projection.project.workspaceId,
          projectId,
          actorId: userId,
          action: 'source_projection.publish_queued',
          targetType: 'projection_generation',
          targetId: created.id,
          metadata: {
            projectionId,
            versionId: version.id,
            generation: generationNumber,
            eventualConsistencyAccepted: true,
          },
        },
      });
      return created;
    });
    try {
      await this.queue.enqueueProjection(generation.id, fencingToken);
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.projectionGeneration.update({
          where: { id: generation.id },
          data: {
            status: 'FAILED',
            errorCode: 'QUEUE_UNAVAILABLE',
            completedAt: new Date(),
          },
        }),
        this.prisma.indexGeneration.update({
          where: { id: generation.indexGenerationId },
          data: { state: 'FAILED' },
        }),
      ]);
      throw error;
    }
    return this.generationResult(generation);
  }

  async generations(userId: string, projectId: string, projectionId: string) {
    this.assertEnabled();
    await this.projection(userId, projectId, projectionId);
    const data = await this.prisma.projectionGeneration.findMany({
      where: { projectionId },
      include: { indexGeneration: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { data: data.map((item) => this.generationResult(item)), meta: {} };
  }

  async sync(
    userId: string,
    projectId: string,
    projectionId: string,
    idempotencyKey: string,
  ) {
    this.assertEnabled();
    const projection = await this.projection(
      userId,
      projectId,
      projectionId,
      'EDITOR',
    );
    if (projection.status !== 'PUBLISHED' || !projection.activeVersionId) {
      throw new BadRequestException('A published projection is required');
    }
    const generation = await this.prisma.projectionGeneration.findFirst({
      where: { projectionId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (!generation) {
      throw new BadRequestException(
        'An active projection generation is required',
      );
    }
    await this.queue.enqueueProjectionSync(
      projection.id,
      projection.activeVersionId,
      generation.fencingToken,
      idempotencyKey,
    );
    await this.prisma.auditLog.create({
      data: {
        workspaceId: projection.project.workspaceId,
        projectId: projection.projectId,
        actorId: userId,
        action: 'source_projection.sync_queued',
        targetType: 'source_projection',
        targetId: projection.id,
        metadata: { versionId: projection.activeVersionId },
      },
    });
    return {
      queued: true,
      projectionId,
      versionId: projection.activeVersionId,
    };
  }

  async previewReconciliation(
    userId: string,
    projectId: string,
    projectionId: string,
    idempotencyKey: string,
  ) {
    this.assertEnabled();
    const projection = await this.projection(
      userId,
      projectId,
      projectionId,
      'EDITOR',
    );
    if (
      projection.status !== 'PUBLISHED' ||
      !projection.activeVersionId ||
      !projection.activeVersion?.schemaFingerprint
    ) {
      throw new BadRequestException('A published projection is required');
    }
    const generation = await this.prisma.projectionGeneration.findFirst({
      where: { projectionId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (!generation) {
      throw new BadRequestException(
        'An active projection generation is required',
      );
    }
    const runId = deterministicUuid(
      `${projectId}:${projectionId}:reconcile:${idempotencyKey}`,
    );
    const idempotent = await this.prisma.projectionReconcileRun.findUnique({
      where: { id: runId },
    });
    if (idempotent) {
      return this.reconciliation(
        userId,
        projectId,
        projectionId,
        idempotent.id,
      );
    }

    const staleBefore = new Date(Date.now() - 30 * 60_000);
    await this.prisma.$transaction([
      this.prisma.projectionReconcileCandidate.updateMany({
        where: {
          reconcileRun: {
            projectionId,
            OR: [
              { status: 'QUEUED', createdAt: { lt: staleBefore } },
              { status: 'SCANNING', scanStartedAt: { lt: staleBefore } },
              {
                status: 'AWAITING_CONFIRMATION',
                expiresAt: { lt: new Date() },
              },
              { status: 'EXECUTING', updatedAt: { lt: staleBefore } },
            ],
          },
          state: { not: 'EXECUTED' },
        },
        data: { state: 'INVALID' },
      }),
      this.prisma.projectionReconcileRun.updateMany({
        where: {
          projectionId,
          OR: [
            { status: 'QUEUED', createdAt: { lt: staleBefore } },
            { status: 'SCANNING', scanStartedAt: { lt: staleBefore } },
            { status: 'AWAITING_CONFIRMATION', expiresAt: { lt: new Date() } },
            { status: 'EXECUTING', updatedAt: { lt: staleBefore } },
          ],
        },
        data: {
          status: 'INVALID',
          invalidReason: 'STALE_RECONCILIATION_LOCK',
        },
      }),
    ]);
    const active = await this.prisma.projectionReconcileRun.findFirst({
      where: {
        projectionId,
        status: {
          in: ['QUEUED', 'SCANNING', 'AWAITING_CONFIRMATION', 'EXECUTING'],
        },
      },
      select: { id: true },
    });
    if (active) {
      return this.reconciliation(userId, projectId, projectionId, active.id);
    }
    const created = await this.prisma.$transaction(async (transaction) => {
      const run = await transaction.projectionReconcileRun.create({
        data: {
          id: runId,
          projectionId,
          projectionVersionId: projection.activeVersionId!,
          projectionGenerationId: generation.id,
          activeIndexGenerationId: generation.indexGenerationId,
          schemaFingerprint: projection.activeVersion!.schemaFingerprint!,
        },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: projection.project.workspaceId,
          projectId,
          actorId: userId,
          action: 'source_projection.reconciliation_queued',
          targetType: 'projection_reconcile_run',
          targetId: run.id,
          metadata: { projectionId, versionId: projection.activeVersionId },
        },
      });
      return run;
    });
    try {
      await this.queue.enqueueProjectionReconcile(created.id, 'scan');
    } catch (error) {
      await this.prisma.projectionReconcileRun.update({
        where: { id: created.id },
        data: { status: 'INVALID', invalidReason: 'QUEUE_UNAVAILABLE' },
      });
      throw error;
    }
    return this.reconciliationResult(created);
  }

  async reconciliation(
    userId: string,
    projectId: string,
    projectionId: string,
    runId: string,
  ) {
    this.assertEnabled();
    await this.projection(userId, projectId, projectionId);
    const run = await this.prisma.projectionReconcileRun.findFirst({
      where: { id: runId, projectionId },
      include: {
        candidates: {
          orderBy: { documentId: 'asc' },
          take: 100,
          select: { id: true, documentId: true, reason: true, state: true },
        },
      },
    });
    if (!run) throw new NotFoundException('Reconciliation run not found');
    if (
      run.status === 'AWAITING_CONFIRMATION' &&
      run.expiresAt &&
      run.expiresAt <= new Date()
    ) {
      await this.prisma.$transaction([
        this.prisma.projectionReconcileRun.update({
          where: { id: run.id },
          data: {
            status: 'INVALID',
            invalidReason: 'RECONCILIATION_APPROVAL_EXPIRED',
          },
        }),
        this.prisma.projectionReconcileCandidate.updateMany({
          where: { reconcileRunId: run.id, state: 'PROPOSED' },
          data: { state: 'INVALID' },
        }),
      ]);
      return {
        ...this.reconciliationResult({
          ...run,
          status: 'INVALID' as const,
          invalidReason: 'RECONCILIATION_APPROVAL_EXPIRED',
        }),
        candidates: run.candidates,
      };
    }
    return {
      ...this.reconciliationResult(run),
      candidates: run.candidates,
      confirmationToken:
        run.status === 'AWAITING_CONFIRMATION' &&
        run.complete &&
        run.candidateSetDigest &&
        run.expiresAt
          ? projectionReconcileToken(
              {
                runId: run.id,
                projectionVersionId: run.projectionVersionId,
                activeIndexGenerationId: run.activeIndexGenerationId,
                candidateSetDigest: run.candidateSetDigest,
                expectedCount: run.expectedCount,
                expiresAt: run.expiresAt.toISOString(),
              },
              Buffer.from(
                this.config.APP_HMAC_KEY ?? this.config.APP_ENCRYPTION_KEY,
                'base64',
              ),
            )
          : undefined,
    };
  }

  async confirmReconciliation(
    userId: string,
    projectId: string,
    projectionId: string,
    runId: string,
    idempotencyKey: string,
    input: ProjectionReconcileConfirmRequest,
  ) {
    this.assertEnabled();
    const projection = await this.projection(
      userId,
      projectId,
      projectionId,
      'EDITOR',
    );
    const run = await this.prisma.projectionReconcileRun.findFirst({
      where: { id: runId, projectionId },
      include: {
        candidates: {
          select: {
            id: true,
            state: true,
            rootKeyHmac: true,
            documentId: true,
            reason: true,
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Reconciliation run not found');
    if (run.status === 'EXECUTING' || run.status === 'EXECUTED') {
      return this.reconciliationResult(run);
    }
    const candidateSetDigest = projectionCandidateSetDigest(run.candidates);
    if (
      !run.tokenHash ||
      !run.candidateSetDigest ||
      !run.expiresAt ||
      !projectionReconciliationCanExecute({
        status: run.status,
        complete: run.complete,
        expectedCount: run.expectedCount,
        actualCount: run.candidates.length,
        candidateSetDigest: run.candidateSetDigest,
        actualCandidateSetDigest: candidateSetDigest,
        expiresAt: run.expiresAt,
      })
    ) {
      throw new ConflictException('Reconciliation approval is not valid');
    }
    if (input.expectedCount !== run.expectedCount) {
      throw new ConflictException('Candidate count changed');
    }
    const expectedToken = projectionReconcileToken(
      {
        runId: run.id,
        projectionVersionId: run.projectionVersionId,
        activeIndexGenerationId: run.activeIndexGenerationId,
        candidateSetDigest: run.candidateSetDigest,
        expectedCount: run.expectedCount,
        expiresAt: run.expiresAt.toISOString(),
      },
      Buffer.from(
        this.config.APP_HMAC_KEY ?? this.config.APP_ENCRYPTION_KEY,
        'base64',
      ),
    );
    const providedHash = projectionReconcileTokenHash(input.token);
    const valid =
      safeEqual(input.token, expectedToken) &&
      safeEqual(providedHash, run.tokenHash);
    if (!valid) throw new ConflictException('Confirmation token is invalid');
    const generation = await this.prisma.projectionGeneration.findFirst({
      where: {
        id: run.projectionGenerationId ?? undefined,
        projectionId,
        projectionVersionId: run.projectionVersionId,
        indexGenerationId: run.activeIndexGenerationId,
        status: 'ACTIVE',
      },
    });
    if (
      !generation ||
      projection.activeVersionId !== run.projectionVersionId ||
      projection.activeVersion?.schemaFingerprint !== run.schemaFingerprint
    ) {
      throw new ConflictException('Reconciliation binding changed');
    }
    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.projectionReconcileRun.updateMany({
        where: { id: run.id, status: 'AWAITING_CONFIRMATION' },
        data: { status: 'EXECUTING' },
      });
      if (!claimed.count) throw new ConflictException('Approval was consumed');
      await transaction.projectionReconcileCandidate.updateMany({
        where: { reconcileRunId: run.id, state: 'PROPOSED' },
        data: { state: 'CONFIRMED' },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: projection.project.workspaceId,
          projectId,
          actorId: userId,
          action: 'source_projection.reconciliation_confirmed',
          targetType: 'projection_reconcile_run',
          targetId: run.id,
          metadata: {
            projectionId,
            expectedCount: run.expectedCount,
            idempotencyKeyHash: createHash('sha256')
              .update(idempotencyKey)
              .digest('hex'),
          },
        },
      });
    });
    try {
      await this.queue.enqueueProjectionReconcile(run.id, 'execute');
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.projectionReconcileRun.updateMany({
          where: { id: run.id, status: 'EXECUTING' },
          data: { status: 'AWAITING_CONFIRMATION' },
        }),
        this.prisma.projectionReconcileCandidate.updateMany({
          where: { reconcileRunId: run.id, state: 'CONFIRMED' },
          data: { state: 'PROPOSED' },
        }),
      ]);
      throw error;
    }
    return this.reconciliationResult({ ...run, status: 'EXECUTING' as const });
  }

  private async validateAgainstSource(
    userId: string,
    projection: Awaited<ReturnType<ProjectionService['projection']>>,
    config: ProjectionConfig,
  ) {
    const catalogResponse = await this.sources.datasets(
      userId,
      projection.sourceId,
    );
    const catalog: CatalogRelation[] = catalogResponse.data.map((relation) => ({
      schema: relation.schemaName,
      table: relation.tableName,
      kind: relation.kind === 'VIEW' ? 'VIEW' : 'BASE TABLE',
      columns: relation.columns,
      primaryKey: relation.primaryKey,
      uniqueKeys: relation.uniqueKeys,
      foreignKeys: relation.foreignKeys,
    }));
    const mapping = projection.searchIndex.mapping as unknown as {
      fields: ProjectionMappingField[];
    };
    return {
      issues: validateProjectionCatalog(config, catalog, mapping.fields ?? []),
      schemaFingerprint: projectionSchemaFingerprint(config, catalog),
    };
  }

  private assertEnabled() {
    if (!this.config.ENABLE_RELATIONAL_PROJECTIONS) {
      throw new NotFoundException('Relational projections are not enabled');
    }
  }

  private generationResult<
    T extends {
      fencingToken: bigint;
      indexGeneration: unknown;
    },
  >(generation: T) {
    return { ...generation, fencingToken: generation.fencingToken.toString() };
  }

  private reconciliationResult<
    T extends {
      id: string;
      status: string;
      complete: boolean;
      expectedCount: number;
      rootCount: number;
      manifestDigest: string | null;
      candidateSetDigest: string | null;
      expiresAt: Date | null;
      invalidReason: string | null;
      scanStartedAt: Date | null;
      scanEndedAt: Date | null;
      executedAt: Date | null;
    },
  >(run: T) {
    return {
      id: run.id,
      status: run.status,
      complete: run.complete,
      expectedCount: run.expectedCount,
      rootCount: run.rootCount,
      manifestDigest: run.manifestDigest,
      candidateSetDigest: run.candidateSetDigest,
      expiresAt: run.expiresAt,
      invalidReason: run.invalidReason,
      scanStartedAt: run.scanStartedAt,
      scanEndedAt: run.scanEndedAt,
      executedAt: run.executedAt,
    };
  }

  private async project(
    userId: string,
    projectId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        workspace: { memberships: { some: { userId } } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    await requireWorkspaceRole(this.prisma, project.workspaceId, userId, role);
    return project;
  }

  private async projection(
    userId: string,
    projectId: string,
    projectionId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const projection = await this.prisma.sourceProjection.findFirst({
      where: {
        id: projectionId,
        projectId,
        project: { workspace: { memberships: { some: { userId } } } },
      },
      include: {
        project: { include: { workspace: true } },
        source: { select: { id: true, name: true } },
        searchIndex: true,
        versions: { orderBy: { version: 'desc' } },
        activeVersion: true,
        draftVersion: true,
      },
    });
    if (!projection) throw new NotFoundException('Projection not found');
    await requireWorkspaceRole(
      this.prisma,
      projection.project.workspaceId,
      userId,
      role,
    );
    return projection;
  }
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(value).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
