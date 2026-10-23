import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  RebuildIndexRequest,
  UploadMetadata,
  WorkspaceRole,
} from '@osc/contracts';
import type { PrismaClient } from '@osc/db';
import {
  bufferChunks,
  encryptStagedFile,
  inferFields,
  parseRows,
} from '@osc/ingestion';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole } from '../workspaces/access.js';
import { IngestionQueueService } from './ingestion-queue.service.js';

interface UploadFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class IngestionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IngestionQueueService)
    private readonly queue: IngestionQueueService,
  ) {}

  async upload(
    userId: string,
    projectId: string,
    metadata: UploadMetadata,
    file?: UploadFile,
  ) {
    const project = await this.project(userId, projectId, 'EDITOR');
    if (!file?.buffer.length)
      throw new BadRequestException('A CSV or JSONL file is required');
    if (file.size > this.config.MAX_UPLOAD_BYTES)
      throw new BadRequestException('Upload exceeds the configured size limit');
    const preview: Record<string, unknown>[] = [];
    let rowCount = 0;
    try {
      for await (const row of parseRows(
        bufferChunks(file.buffer),
        metadata.format,
      )) {
        rowCount += 1;
        if (preview.length < 20) preview.push(row);
      }
    } catch {
      throw new BadRequestException(`Invalid ${metadata.format} upload`);
    }
    if (!rowCount) throw new BadRequestException('Upload contains no records');
    const schema = inferFields(preview);
    await mkdir(this.config.UPLOAD_STAGING_DIR, {
      recursive: true,
      mode: 0o700,
    });
    const stagingPath = join(
      this.config.UPLOAD_STAGING_DIR,
      `${randomUUID()}.enc`,
    );
    await encryptStagedFile(
      stagingPath,
      file.buffer,
      this.config.APP_ENCRYPTION_KEY,
    );
    const source = await this.prisma.dataSource.create({
      data: {
        projectId,
        name: metadata.name,
        format: metadata.format,
        stagingPath,
        originalName: file.originalname,
        sizeBytes: file.size,
        rowCount,
        schema,
      },
      select: this.sourceSelect(),
    });
    await this.prisma.auditLog.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        actorId: userId,
        action: 'upload.created',
        targetType: 'data_source',
        targetId: source.id,
        metadata: {
          format: source.format,
          rowCount,
          sizeBytes: source.sizeBytes,
        },
      },
    });
    return { ...source, preview };
  }

  async listSources(userId: string, projectId: string) {
    await this.project(userId, projectId);
    return {
      data: await this.prisma.dataSource.findMany({
        where: { projectId, type: 'UPLOAD' },
        select: this.sourceSelect(),
        orderBy: { createdAt: 'desc' },
      }),
      meta: {},
    };
  }

  async rebuild(
    userId: string,
    indexId: string,
    input: RebuildIndexRequest,
    trigger = 'UPLOAD_REBUILD',
  ) {
    const index = await this.index(userId, indexId, 'EDITOR');
    const source = await this.prisma.dataSource.findFirst({
      where: { id: input.sourceId, projectId: index.projectId },
    });
    if (!source) throw new NotFoundException('Source not found');
    if (source.type === 'POSTGRES') {
      return this.postgresRebuild(userId, indexId);
    }
    if (!input.idField) {
      throw new BadRequestException('Upload rebuild requires an ID field');
    }
    const fields = source.schema as Array<{ name: string }>;
    if (!fields.some((field) => field.name === input.idField))
      throw new BadRequestException(
        'ID field is not present in the upload schema',
      );
    const latest = await this.prisma.indexGeneration.aggregate({
      where: { searchIndexId: indexId },
      _max: { generation: true },
    });
    const generation = (latest._max.generation ?? 0) + 1;
    const run = await this.prisma.$transaction(async (transaction) => {
      const generationRecord = await transaction.indexGeneration.create({
        data: {
          searchIndexId: indexId,
          generation,
          physicalCollection: `${index.alias}_v${generation}`,
        },
      });
      await transaction.searchIndex.update({
        where: { id: indexId },
        data: { sourceId: source.id },
      });
      const created = await transaction.ingestionRun.create({
        data: {
          searchIndexId: indexId,
          generationId: generationRecord.id,
          sourceId: source.id,
          triggeredById: userId,
          trigger,
          cursor: { idField: input.idField },
        },
        include: {
          generation: true,
          source: { select: { id: true, name: true, rowCount: true } },
        },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: index.project.workspaceId,
          projectId: index.projectId,
          actorId: userId,
          action: 'ingestion_run.queued',
          targetType: 'ingestion_run',
          targetId: created.id,
          metadata: { generation, trigger },
        },
      });
      return created;
    });
    try {
      await this.queue.enqueue(run.id);
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.ingestionRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            errorSummary: 'Queue unavailable',
            finishedAt: new Date(),
          },
        }),
        this.prisma.indexGeneration.update({
          where: { id: run.generationId! },
          data: { state: 'FAILED' },
        }),
      ]);
      throw error;
    }
    return run;
  }

  async listRuns(userId: string, indexId: string) {
    await this.index(userId, indexId);
    return {
      data: await this.prisma.ingestionRun.findMany({
        where: { searchIndexId: indexId },
        include: this.runInclude(),
        orderBy: { createdAt: 'desc' },
      }),
      meta: {},
    };
  }
  async getRun(userId: string, runId: string) {
    return this.run(userId, runId);
  }
  async errors(userId: string, runId: string) {
    await this.run(userId, runId);
    return {
      data: await this.prisma.ingestionError.findMany({
        where: { runId },
        orderBy: { createdAt: 'asc' },
        take: 1_000,
      }),
      meta: {},
    };
  }
  async cancel(userId: string, runId: string) {
    const run = await this.run(userId, runId, 'EDITOR');
    if (!['QUEUED', 'RUNNING'].includes(run.status))
      throw new BadRequestException(
        'Only queued or running runs can be cancelled',
      );
    return this.prisma.ingestionRun.update({
      where: { id: runId },
      data: { status: 'CANCEL_REQUESTED' },
    });
  }
  async retry(userId: string, runId: string) {
    const run = await this.run(userId, runId, 'EDITOR');
    if (!['PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(run.status))
      throw new BadRequestException('Only unsuccessful runs can be retried');
    if (run.source.type === 'POSTGRES') {
      return this.sync(userId, run.searchIndexId, 'RETRY_FAILED');
    }
    const cursor = run.cursor as { idField?: string };
    if (!cursor.idField)
      throw new BadRequestException('Run has no ID field checkpoint');
    return this.rebuild(
      userId,
      run.searchIndexId,
      { sourceId: run.sourceId, idField: cursor.idField },
      'RETRY_FAILED',
    );
  }

  async sync(userId: string, indexId: string, trigger = 'POSTGRES_SYNC') {
    const index = await this.postgresIndex(userId, indexId, 'EDITOR');
    const existing = await this.prisma.ingestionRun.findFirst({
      where: {
        searchIndexId: indexId,
        status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] },
      },
    });
    if (existing)
      throw new BadRequestException('A synchronization is already active');
    const run = await this.prisma.ingestionRun.create({
      data: {
        searchIndexId: indexId,
        sourceId: index.sourceId!,
        triggeredById: userId,
        trigger,
      },
      include: this.runInclude(),
    });
    await this.enqueueOrFail(run.id, 'postgres-sync');
    return run;
  }

  async postgresRebuild(userId: string, indexId: string) {
    const index = await this.postgresIndex(userId, indexId, 'EDITOR');
    const latest = await this.prisma.indexGeneration.aggregate({
      where: { searchIndexId: indexId },
      _max: { generation: true },
    });
    const generation = (latest._max.generation ?? 0) + 1;
    const run = await this.prisma.$transaction(async (transaction) => {
      const createdGeneration = await transaction.indexGeneration.create({
        data: {
          searchIndexId: indexId,
          generation,
          physicalCollection: `${index.alias}_v${generation}`,
        },
      });
      return transaction.ingestionRun.create({
        data: {
          searchIndexId: indexId,
          generationId: createdGeneration.id,
          sourceId: index.sourceId!,
          triggeredById: userId,
          trigger: 'POSTGRES_REBUILD',
        },
        include: this.runInclude(),
      });
    });
    await this.enqueueOrFail(run.id, 'postgres-rebuild', run.generationId);
    return run;
  }

  async reconcilePreview(userId: string, indexId: string) {
    const index = await this.postgresIndex(userId, indexId, 'EDITOR');
    const token = randomBytes(32).toString('base64url');
    const preview = await this.prisma.reconciliationPreview.create({
      data: {
        searchIndexId: indexId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    const run = await this.prisma.ingestionRun.create({
      data: {
        searchIndexId: indexId,
        sourceId: index.sourceId!,
        triggeredById: userId,
        trigger: 'RECONCILE_PREVIEW',
        cursor: { reconciliationId: preview.id },
      },
      include: this.runInclude(),
    });
    await this.enqueueOrFail(run.id, 'reconcile-preview');
    return { run, token, expiresAt: preview.expiresAt };
  }

  async reconcileExecute(userId: string, indexId: string, token: string) {
    const index = await this.postgresIndex(userId, indexId, 'EDITOR');
    const preview = await this.prisma.reconciliationPreview.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (
      !preview ||
      preview.searchIndexId !== indexId ||
      !preview.complete ||
      preview.failureReason ||
      preview.executedAt ||
      preview.expiresAt <= new Date()
    ) {
      throw new BadRequestException(
        'Reconciliation preview is incomplete, expired, or already used',
      );
    }
    const claimed = await this.prisma.reconciliationPreview.updateMany({
      where: { id: preview.id, executedAt: null },
      data: { executedAt: new Date() },
    });
    if (!claimed.count) {
      throw new BadRequestException('Reconciliation preview is already used');
    }
    const run = await this.prisma.ingestionRun.create({
      data: {
        searchIndexId: indexId,
        sourceId: index.sourceId!,
        triggeredById: userId,
        trigger: 'RECONCILE_EXECUTE',
        cursor: { reconciliationId: preview.id },
      },
      include: this.runInclude(),
    });
    await this.enqueueOrFail(run.id, 'reconcile-execute');
    return run;
  }

  async reconciliation(userId: string, runId: string) {
    const run = await this.run(userId, runId);
    const cursor = run.cursor as { reconciliationId?: string };
    if (!cursor.reconciliationId)
      throw new NotFoundException('Reconciliation preview not found');
    const preview = await this.prisma.reconciliationPreview.findUnique({
      where: { id: cursor.reconciliationId },
      select: {
        id: true,
        sourceCount: true,
        indexedCount: true,
        missingIds: true,
        complete: true,
        failureReason: true,
        expiresAt: true,
        executedAt: true,
      },
    });
    if (!preview)
      throw new NotFoundException('Reconciliation preview not found');
    return preview;
  }

  private async enqueueOrFail(
    runId: string,
    name: string,
    generationId?: string | null,
  ) {
    try {
      await this.queue.enqueue(runId, name);
    } catch (error) {
      await this.prisma.ingestionRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          errorSummary: 'Queue unavailable',
          finishedAt: new Date(),
        },
      });
      if (generationId) {
        await this.prisma.indexGeneration.update({
          where: { id: generationId },
          data: { state: 'FAILED' },
        });
      }
      throw error;
    }
  }

  private sourceSelect() {
    return {
      id: true,
      projectId: true,
      name: true,
      type: true,
      state: true,
      format: true,
      originalName: true,
      sizeBytes: true,
      rowCount: true,
      schema: true,
      createdAt: true,
    } as const;
  }
  private runInclude() {
    return {
      generation: true,
      source: { select: { id: true, name: true, type: true, rowCount: true } },
      _count: { select: { errors: true } },
    } as const;
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
  private async index(
    userId: string,
    indexId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const index = await this.prisma.searchIndex.findFirst({
      where: {
        id: indexId,
        project: { workspace: { memberships: { some: { userId } } } },
      },
      include: { project: true },
    });
    if (!index) throw new NotFoundException('Search index not found');
    await requireWorkspaceRole(
      this.prisma,
      index.project.workspaceId,
      userId,
      role,
    );
    return index;
  }
  private async postgresIndex(
    userId: string,
    indexId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const index = await this.prisma.searchIndex.findFirst({
      where: {
        id: indexId,
        source: { type: 'POSTGRES' },
        sourceDatasetId: { not: null },
        project: { workspace: { memberships: { some: { userId } } } },
      },
      include: { project: true },
    });
    if (!index)
      throw new NotFoundException('Configured PostgreSQL index not found');
    await requireWorkspaceRole(
      this.prisma,
      index.project.workspaceId,
      userId,
      role,
    );
    return index;
  }
  private async run(
    userId: string,
    runId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const run = await this.prisma.ingestionRun.findFirst({
      where: {
        id: runId,
        searchIndex: {
          project: { workspace: { memberships: { some: { userId } } } },
        },
      },
      include: {
        ...this.runInclude(),
        searchIndex: { include: { project: true } },
      },
    });
    if (!run) throw new NotFoundException('Ingestion run not found');
    await requireWorkspaceRole(
      this.prisma,
      run.searchIndex.project.workspaceId,
      userId,
      role,
    );
    return run;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
