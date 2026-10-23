import { describe, expect, it } from 'vitest';

import { apiEnvironmentSchema, workerEnvironmentSchema } from '../src/index.js';

const shared = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('M7 relational projection feature flag', () => {
  it('is enabled by default in API and worker environments', () => {
    expect(
      apiEnvironmentSchema.parse({
        ...shared,
        TYPESENSE_URL: 'http://localhost:8108',
        TYPESENSE_API_KEY: 'test-key',
        SETUP_TOKEN: 'test-setup-token-value',
        APP_ORIGIN: 'http://localhost:3000',
      }).ENABLE_RELATIONAL_PROJECTIONS,
    ).toBe(true);
    expect(
      workerEnvironmentSchema.parse(shared).ENABLE_RELATIONAL_PROJECTIONS,
    ).toBe(true);
  });

  it('accepts an explicit override and rejects invalid values', () => {
    expect(
      workerEnvironmentSchema.parse({
        ...shared,
        ENABLE_RELATIONAL_PROJECTIONS: 'false',
      }).ENABLE_RELATIONAL_PROJECTIONS,
    ).toBe(false);
    expect(
      workerEnvironmentSchema.safeParse({
        ...shared,
        ENABLE_RELATIONAL_PROJECTIONS: 'yes',
      }).success,
    ).toBe(false);
  });
});
