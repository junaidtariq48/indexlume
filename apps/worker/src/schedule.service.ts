import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createPrismaClient } from '@osc/db';
import type { Queue } from 'bullmq';
import { workerEnvironmentSchema } from '@osc/contracts';
import {
  projectionConfigSchema,
  projectionReconciliationDue,
} from '@osc/ingestion';

const config = workerEnvironmentSchema.parse(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);

@Injectable()
export class ScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleService.name);
  private timer?: NodeJS.Timeout;

  constructor(@InjectQueue('ingestion') private readonly queue: Queue) {}

  onModuleInit() {
    this.timer = setInterval(() => this.runTick(), 30_000);
    this.timer.unref();
    this.runTick();
  }

  private runTick() {
    void this.tick().catch(() =>
      this.logger.error('Scheduled synchronization scan failed'),
    );
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const now = new Date();
    const schedules = await prisma.scheduledSync.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      include: { searchIndex: true },
      take: 25,
      orderBy: { nextRunAt: 'asc' },
    });
    for (const schedule of schedules) {
      if (!schedule.searchIndex.sourceId) continue;
      const claimed = await prisma.scheduledSync.updateMany({
        where: {
          id: schedule.id,
          enabled: true,
          nextRunAt: schedule.nextRunAt,
        },
        data: {
          lastQueuedAt: now,
          nextRunAt: new Date(
            now.getTime() + schedule.intervalMinutes * 60_000,
          ),
        },
      });
      if (!claimed.count) continue;
      const active = await prisma.ingestionRun.findFirst({
        where: {
          searchIndexId: schedule.searchIndexId,
          status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] },
        },
      });
      if (active) continue;
      const run = await prisma.ingestionRun.create({
        data: {
          searchIndexId: schedule.searchIndexId,
          sourceId: schedule.searchIndex.sourceId,
          trigger: 'SCHEDULED_POSTGRES_SYNC',
        },
      });
      try {
        await this.queue.add(
          'postgres-sync',
          { runId: run.id },
          {
            jobId: run.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1_000 },
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        );
      } catch {
        await prisma.ingestionRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            errorSummary: 'Queue unavailable',
            finishedAt: new Date(),
          },
        });
        this.logger.error(`Scheduled run ${run.id} could not be queued`);
      }
    }
    if (!config.ENABLE_RELATIONAL_PROJECTIONS) return;
    const projections = await prisma.sourceProjection.findMany({
      where: {
        status: 'PUBLISHED',
        activeVersionId: { not: null },
        activeVersion: { isNot: null },
        generations: { some: { status: 'ACTIVE' } },
      },
      include: {
        activeVersion: true,
        relationCursors: true,
        generations: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        reconcileRuns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      take: 25,
      orderBy: { updatedAt: 'asc' },
    });
    for (const projection of projections) {
      const version = projection.activeVersion;
      const generation = projection.generations[0];
      if (!version || !generation || !projection.activeVersionId) continue;
      const projectionConfig = projectionConfigSchema.parse(version.config);
      const intervalMs = projectionConfig.sync.pollSeconds * 1_000;
      const expectedCursorCount =
        (projectionConfig.root.changeTracking.mode === 'poll' ? 1 : 0) +
        projectionConfig.relations.filter(
          (relation) => relation.changeTracking.mode === 'poll',
        ).length;
      if (expectedCursorCount) {
        const cursors = projection.relationCursors.filter(
          (cursor) => cursor.projectionVersionId === projection.activeVersionId,
        );
        const lastCompleted = cursors.reduce<Date | undefined>(
          (earliest, cursor) =>
            cursor.completedAt && (!earliest || cursor.completedAt < earliest)
              ? cursor.completedAt
              : earliest,
          undefined,
        );
        if (
          cursors.length < expectedCursorCount ||
          !lastCompleted ||
          lastCompleted.getTime() + intervalMs <= now.getTime()
        ) {
          const bucket = Math.floor(now.getTime() / intervalMs);
          try {
            await this.queue.add(
              'projection-scan-changes',
              {
                projectionId: projection.id,
                projectionVersionId: projection.activeVersionId,
                fencingToken: generation.fencingToken.toString(),
              },
              {
                jobId: `projection-sync-${projection.id}-${bucket}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 1_000 },
                removeOnComplete: 100,
                removeOnFail: 100,
              },
            );
          } catch {
            this.logger.error(
              `Scheduled projection sync ${projection.id} could not be queued`,
            );
          }
        }
      }

      await this.scheduleReconciliation(
        projection,
        generation,
        projectionConfig.sync.reconcileHours,
        now,
      );
    }
  }

  private async scheduleReconciliation(
    projection: {
      id: string;
      activeVersionId: string | null;
      activeVersion: { schemaFingerprint: string | null } | null;
      reconcileRuns: Array<{
        id: string;
        status: string;
        createdAt: Date;
        expiresAt: Date | null;
      }>;
    },
    generation: { id: string; indexGenerationId: string },
    reconcileHours: number,
    now: Date,
  ) {
    if (
      !projection.activeVersionId ||
      !projection.activeVersion?.schemaFingerprint
    )
      return;
    const latest = projection.reconcileRuns[0];
    if (
      latest?.status === 'AWAITING_CONFIRMATION' &&
      latest.expiresAt &&
      latest.expiresAt <= now
    ) {
      await prisma.$transaction([
        prisma.projectionReconcileCandidate.updateMany({
          where: { reconcileRunId: latest.id, state: 'PROPOSED' },
          data: { state: 'INVALID' },
        }),
        prisma.projectionReconcileRun.updateMany({
          where: { id: latest.id, status: 'AWAITING_CONFIRMATION' },
          data: {
            status: 'INVALID',
            invalidReason: 'RECONCILIATION_APPROVAL_EXPIRED',
          },
        }),
      ]);
    }
    if (
      !projectionReconciliationDue({
        reconcileHours,
        now,
        latest,
      })
    )
      return;
    const run = await prisma.projectionReconcileRun.create({
      data: {
        projectionId: projection.id,
        projectionVersionId: projection.activeVersionId,
        projectionGenerationId: generation.id,
        activeIndexGenerationId: generation.indexGenerationId,
        schemaFingerprint: projection.activeVersion.schemaFingerprint,
      },
    });
    try {
      await this.queue.add(
        'projection-reconcile',
        { reconcileRunId: run.id, action: 'scan' },
        {
          jobId: `projection-reconcile-scan-${run.id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      this.logger.log(`Scheduled reconciliation ${run.id} queued`);
    } catch {
      await prisma.projectionReconcileRun.update({
        where: { id: run.id },
        data: { status: 'INVALID', invalidReason: 'QUEUE_UNAVAILABLE' },
      });
      this.logger.error(
        `Scheduled reconciliation ${run.id} could not be queued`,
      );
    }
  }
}
