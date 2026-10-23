import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@osc/db';
import { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA, REDIS } from './tokens.js';

class InfrastructureShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createPrismaClient(config.DATABASE_URL),
    },
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Redis(config.REDIS_URL, {
          enableOfflineQueue: false,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        }),
    },
    InfrastructureShutdown,
  ],
  exports: [PRISMA, REDIS],
})
export class InfrastructureModule {}
