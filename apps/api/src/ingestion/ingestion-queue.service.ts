import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../app-config.js';

export const INGESTION_QUEUE = 'ingestion';

@Injectable()
export class IngestionQueueService implements OnModuleDestroy {
  private readonly queue: Queue;
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.queue = new Queue(INGESTION_QUEUE, {
      connection: { url: config.REDIS_URL },
    });
  }
  async enqueue(runId: string, name = 'rebuild'): Promise<void> {
    await this.queue.add(
      name,
      { runId },
      {
        jobId: runId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }
  async enqueueProjection(
    projectionGenerationId: string,
    fencingToken: bigint,
  ): Promise<void> {
    await this.queue.add(
      'projection-snapshot',
      { projectionGenerationId, fencingToken: fencingToken.toString() },
      {
        jobId: `projection-${projectionGenerationId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }
  async enqueueProjectionSync(
    projectionId: string,
    projectionVersionId: string,
    fencingToken: bigint,
    idempotencyKey: string,
  ): Promise<void> {
    await this.queue.add(
      'projection-scan-changes',
      {
        projectionId,
        projectionVersionId,
        fencingToken: fencingToken.toString(),
      },
      {
        jobId: `projection-sync-${projectionId}-${createHash('sha256').update(idempotencyKey).digest('hex')}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }
  async enqueueProjectionReconcile(
    reconcileRunId: string,
    action: 'scan' | 'execute',
  ): Promise<void> {
    await this.queue.add(
      'projection-reconcile',
      { reconcileRunId, action },
      {
        jobId: `projection-reconcile-${action}-${reconcileRunId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
