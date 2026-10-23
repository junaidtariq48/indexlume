import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { workerEnvironmentSchema } from '@osc/contracts';
import { Redis } from 'ioredis';
import { createPrismaClient, type PrismaClient } from '@osc/db';

@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private readonly config = workerEnvironmentSchema.parse(process.env);
  private readonly prisma: PrismaClient = createPrismaClient(
    this.config.DATABASE_URL,
  );
  private readonly redis = new Redis(this.config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  async onApplicationBootstrap(): Promise<void> {
    await this.redis.ping();
    this.logger.log('Worker connected to Redis and is ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
    await this.prisma.$disconnect();
  }
}
