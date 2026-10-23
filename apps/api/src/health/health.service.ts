import { Inject, Injectable } from '@nestjs/common';
import type { DependencyHealth, ReadinessResponse } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';
import type { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA, REDIS } from '../infrastructure/tokens.js';

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<ReadinessResponse> {
    const [postgres, redis, typesense] = await Promise.all([
      this.probePostgres(),
      this.probeRedis(),
      this.probeTypesense(),
    ]);
    const dependencies: DependencyHealth = { postgres, redis, typesense };

    return {
      status: Object.values(dependencies).every(Boolean)
        ? 'ready'
        : 'not_ready',
      dependencies,
    };
  }

  private async probePostgres(): Promise<boolean> {
    return this.probe(async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  private async probeRedis(): Promise<boolean> {
    return this.probe(async () => {
      if (this.redis.status === 'wait') {
        await this.redis.connect();
      }
      await this.redis.ping();
    });
  }

  private async probeTypesense(): Promise<boolean> {
    return this.probe(async () => {
      const response = await fetch(
        new URL('/health', this.config.TYPESENSE_URL),
        {
          headers: { 'X-TYPESENSE-API-KEY': this.config.TYPESENSE_API_KEY },
          signal: AbortSignal.timeout(2_000),
        },
      );

      if (!response.ok) {
        throw new Error(`Typesense health returned ${response.status}`);
      }
    });
  }

  private async probe(operation: () => Promise<void>): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch {
      return false;
    }
  }
}
