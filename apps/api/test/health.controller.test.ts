import { describe, expect, it } from 'vitest';

import { HealthController } from '../src/health/health.controller.js';
import type { HealthService } from '../src/health/health.service.js';

describe('HealthController', () => {
  it('reports liveness without checking dependencies', () => {
    const controller = new HealthController({} as HealthService);

    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('returns dependency state when all services are ready', async () => {
    const healthService = {
      check: async () => ({
        status: 'ready' as const,
        dependencies: { postgres: true, redis: true, typesense: true },
      }),
    } as HealthService;
    const controller = new HealthController(healthService);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ready',
      dependencies: { postgres: true, redis: true, typesense: true },
    });
  });
});
