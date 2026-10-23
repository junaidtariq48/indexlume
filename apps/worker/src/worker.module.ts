import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { workerEnvironmentSchema } from '@osc/contracts';

import { WorkerService } from './worker.service.js';
import { IngestionProcessor } from './ingestion.processor.js';
import { PostgresSyncService } from './postgres-sync.service.js';
import { ProjectionSnapshotService } from './projection-snapshot.service.js';
import { ProjectionSyncService } from './projection-sync.service.js';
import { ProjectionReconcileService } from './projection-reconcile.service.js';
import { ScheduleService } from './schedule.service.js';

const config = workerEnvironmentSchema.parse(process.env);
const redisUrl = new URL(config.REDIS_URL);

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || '6379'),
        username: redisUrl.username || undefined,
        password: redisUrl.password || undefined,
        tls: redisUrl.protocol === 'rediss:' ? {} : undefined,
      },
    }),
    BullModule.registerQueue({ name: 'ingestion' }),
  ],
  providers: [
    WorkerService,
    PostgresSyncService,
    ProjectionSnapshotService,
    ProjectionSyncService,
    ProjectionReconcileService,
    IngestionProcessor,
    ScheduleService,
  ],
})
export class WorkerModule {}
