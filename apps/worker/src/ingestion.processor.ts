import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { workerEnvironmentSchema, type IndexField } from '@osc/contracts';
import { createPrismaClient } from '@osc/db';
import { decryptEnvelope, decryptStagedFile, parseRows } from '@osc/ingestion';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { PostgresSyncService } from './postgres-sync.service.js';
import { ProjectionSnapshotService } from './projection-snapshot.service.js';
import { ProjectionSyncService } from './projection-sync.service.js';
import { ProjectionReconcileService } from './projection-reconcile.service.js';

const config = workerEnvironmentSchema.parse(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);

@Processor('ingestion', { concurrency: config.INGEST_WORKER_CONCURRENCY })
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    @Inject(PostgresSyncService)
    private readonly postgresSync: PostgresSyncService,
    @Inject(ProjectionSnapshotService)
    private readonly projectionSnapshot: ProjectionSnapshotService,
    @Inject(ProjectionSyncService)
    private readonly projectionSync: ProjectionSyncService,
    @Inject(ProjectionReconcileService)
    private readonly projectionReconcile: ProjectionReconcileService,
  ) {
    super();
  }

  async process(
    job: Job<{
      runId?: string;
      projectionGenerationId?: string;
      fencingToken?: string;
      projectionId?: string;
      projectionVersionId?: string;
      reconcileRunId?: string;
      action?: 'scan' | 'execute';
    }>,
  ): Promise<void> {
    if (job.name === 'projection-reconcile') {
      if (!job.data.reconcileRunId || !job.data.action) {
        throw new Error('Projection reconciliation job is not configured');
      }
      await this.projectionReconcile.process(
        job.data.reconcileRunId,
        job.data.action,
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      );
      return;
    }
    if (job.name === 'projection-snapshot') {
      if (!job.data.projectionGenerationId || !job.data.fencingToken) {
        throw new Error('Projection snapshot job is not fully configured');
      }
      await this.projectionSnapshot.process(
        job.data.projectionGenerationId,
        job.data.fencingToken,
        job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      );
      return;
    }
    if (
      job.name === 'projection-scan-changes' ||
      job.name === 'projection-rebuild-roots'
    ) {
      if (
        !job.data.projectionId ||
        !job.data.projectionVersionId ||
        !job.data.fencingToken
      ) {
        throw new Error('Projection synchronization job is not configured');
      }
      await this.projectionSync.process(
        job.data.projectionId,
        job.data.projectionVersionId,
        job.data.fencingToken,
      );
      return;
    }
    if (!job.data.runId) throw new Error('Ingestion job has no run ID');
    if (job.name !== 'rebuild') {
      await this.postgresSync.process(job.name, job.data.runId);
      return;
    }
    const run = await prisma.ingestionRun.findUnique({
      where: { id: job.data.runId },
      include: {
        generation: true,
        source: true,
        searchIndex: {
          include: { project: { include: { typesenseConnection: true } } },
        },
      },
    });
    if (!run) return;
    const generation = run.generation;
    if (
      run.source.type !== 'UPLOAD' ||
      !generation ||
      !run.generationId ||
      !run.source.stagingPath ||
      !run.source.format ||
      run.source.rowCount === null
    ) {
      throw new Error('Upload rebuild run is not fully configured');
    }
    const generationId = run.generationId;
    const stagingPath = run.source.stagingPath;
    const format = run.source.format;
    const rowCount = run.source.rowCount;
    if (run.status === 'CANCEL_REQUESTED') {
      await this.finishCancelled(run.id, generationId);
      return;
    }
    const connection = run.searchIndex.project.typesenseConnection;
    if (!connection) throw new Error('Project has no Typesense connection');
    const credentials = {
      endpoint: connection.endpoint,
      apiKey: decryptSecret(connection.encryptedApiKey),
    };
    const mapping = run.searchIndex.mapping as unknown as {
      fields: IndexField[];
      defaultSortingField?: string;
    };
    const cursor = run.cursor as { idField?: string };
    if (!cursor.idField) throw new Error('Run has no ID field');
    await prisma.$transaction([
      prisma.ingestionError.deleteMany({ where: { runId: run.id } }),
      prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: 'RUNNING',
          scanned: 0,
          succeeded: 0,
          failed: 0,
          errorSummary: null,
          startedAt: new Date(),
          finishedAt: null,
        },
      }),
    ]);
    await tsDelete(
      credentials,
      `/collections/${encodeURIComponent(generation.physicalCollection)}`,
    );
    try {
      await tsRequest(credentials, '/collections', {
        method: 'POST',
        body: JSON.stringify({
          name: generation.physicalCollection,
          fields: mapping.fields.map((field) => ({
            name: field.name,
            type: field.type,
            facet: field.facet,
            optional: field.optional,
            sort: field.sort,
            index: field.searchable || field.facet || field.sort,
          })),
          ...(mapping.defaultSortingField
            ? { default_sorting_field: mapping.defaultSortingField }
            : {}),
        }),
      });
      let batch: Array<Record<string, unknown>> = [];
      let bytes = 0;
      let scanned = 0;
      let succeeded = 0;
      let failed = 0;
      const flush = async () => {
        if (!batch.length) return;
        const status = await prisma.ingestionRun.findUnique({
          where: { id: run.id },
          select: { status: true },
        });
        if (status?.status === 'CANCEL_REQUESTED') throw new CancelledError();
        const results = await tsImport(
          credentials,
          generation.physicalCollection,
          batch,
        );
        const errors: Array<{
          runId: string;
          sourceKey: string;
          code: string;
          sanitizedMessage: string;
          payloadFingerprint: string;
        }> = [];
        results.forEach((result, index) => {
          if (result.success) succeeded += 1;
          else {
            failed += 1;
            const document = batch[index] ?? {};
            errors.push({
              runId: run.id,
              sourceKey: String(document.id ?? `row-${scanned + index}`),
              code: 'TYPESENSE_IMPORT',
              sanitizedMessage: 'Typesense rejected this record',
              payloadFingerprint: createHash('sha256')
                .update(JSON.stringify(document))
                .digest('hex'),
            });
          }
        });
        scanned += batch.length;
        await prisma.$transaction([
          ...(errors.length
            ? [prisma.ingestionError.createMany({ data: errors })]
            : []),
          prisma.ingestionRun.update({
            where: { id: run.id },
            data: {
              scanned,
              succeeded,
              failed,
              cursor: { idField: cursor.idField, checkpoint: scanned },
            },
          }),
        ]);
        batch = [];
        bytes = 0;
      };
      for await (const sourceRow of parseRows(
        decryptStagedFile(stagingPath, [
          config.APP_ENCRYPTION_KEY,
          ...config.APP_ENCRYPTION_KEY_PREVIOUS.split(',').filter(Boolean),
        ]),
        format,
      )) {
        const idValue = sourceRow[cursor.idField];
        const document: Record<string, unknown> = { id: normalizeId(idValue) };
        for (const field of mapping.fields)
          if (
            sourceRow[field.name] !== undefined &&
            sourceRow[field.name] !== null
          )
            document[field.name] = sourceRow[field.name];
        const size = Buffer.byteLength(JSON.stringify(document));
        if (
          batch.length &&
          (batch.length >= config.INGEST_BATCH_DOCUMENTS ||
            bytes + size > config.INGEST_BATCH_BYTES)
        )
          await flush();
        batch.push(document);
        bytes += size;
      }
      await flush();
      if (failed > 0 || succeeded + failed !== rowCount) {
        await tsDelete(
          credentials,
          `/collections/${encodeURIComponent(generation.physicalCollection)}`,
        );
        await prisma.$transaction([
          prisma.indexGeneration.update({
            where: { id: generationId },
            data: { state: 'FAILED', recordCount: succeeded },
          }),
          prisma.ingestionRun.update({
            where: { id: run.id },
            data: {
              status: 'PARTIAL_FAILED',
              errorSummary: `${failed} records failed`,
              finishedAt: new Date(),
            },
          }),
        ]);
        return;
      }
      await tsRequest(
        credentials,
        `/aliases/${encodeURIComponent(run.searchIndex.alias)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            collection_name: generation.physicalCollection,
          }),
        },
      );
      await prisma.$transaction(async (transaction) => {
        await transaction.indexGeneration.updateMany({
          where: { searchIndexId: run.searchIndexId, state: 'ACTIVE' },
          data: { state: 'SUPERSEDED' },
        });
        await transaction.indexGeneration.update({
          where: { id: generationId },
          data: {
            state: 'ACTIVE',
            recordCount: succeeded,
            activatedAt: new Date(),
          },
        });
        await transaction.searchIndex.update({
          where: { id: run.searchIndexId },
          data: { activeGeneration: generation.generation, state: 'READY' },
        });
        await transaction.ingestionRun.update({
          where: { id: run.id },
          data: { status: 'SUCCEEDED', finishedAt: new Date() },
        });
      });
    } catch (error) {
      await tsDelete(
        credentials,
        `/collections/${encodeURIComponent(generation.physicalCollection)}`,
      ).catch(() => undefined);
      if (error instanceof CancelledError) {
        await this.finishCancelled(run.id, generationId);
        return;
      }
      await prisma.$transaction([
        prisma.indexGeneration.update({
          where: { id: generationId },
          data: { state: 'FAILED' },
        }),
        prisma.ingestionRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            errorSummary: 'Ingestion dependency failed',
            finishedAt: new Date(),
          },
        }),
      ]);
      this.logger.error(`Ingestion run ${run.id} failed`);
      throw error;
    }
  }

  private async finishCancelled(runId: string, generationId: string) {
    await prisma.$transaction([
      prisma.indexGeneration.update({
        where: { id: generationId },
        data: { state: 'FAILED' },
      }),
      prisma.ingestionRun.update({
        where: { id: runId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      }),
    ]);
  }
}

class CancelledError extends Error {}
function normalizeId(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('ID field must contain strings or numbers');
  const id = String(value).trim();
  if (!id) throw new Error('ID field cannot be empty');
  return id;
}
function decryptSecret(envelope: string): string {
  return decryptEnvelope(
    'typesense-api-key',
    envelope,
    config.APP_ENCRYPTION_KEY,
    config.APP_ENCRYPTION_KEY_PREVIOUS,
  ).toString('utf8');
}
async function tsRequest(
  credentials: { endpoint: string; apiKey: string },
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(new URL(path, `${credentials.endpoint}/`), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-typesense-api-key': credentials.apiKey,
      ...init.headers,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(config.TYPESENSE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Typesense request failed (${response.status})`);
  return response.text();
}
async function tsDelete(
  credentials: { endpoint: string; apiKey: string },
  path: string,
) {
  const response = await fetch(new URL(path, `${credentials.endpoint}/`), {
    method: 'DELETE',
    headers: { 'x-typesense-api-key': credentials.apiKey },
    redirect: 'error',
    signal: AbortSignal.timeout(config.TYPESENSE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Typesense delete failed (${response.status})`);
}
async function tsImport(
  credentials: { endpoint: string; apiKey: string },
  collection: string,
  documents: Array<Record<string, unknown>>,
): Promise<Array<{ success: boolean }>> {
  const text = await tsRequest(
    credentials,
    `/collections/${encodeURIComponent(collection)}/documents/import?action=upsert`,
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: documents.map((item) => JSON.stringify(item)).join('\n'),
    },
  );
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length !== documents.length)
    return documents.map(() => ({ success: false }));
  return lines.map((line) => {
    try {
      return {
        success: (JSON.parse(line) as { success?: boolean }).success === true,
      };
    } catch {
      return { success: false };
    }
  });
}
