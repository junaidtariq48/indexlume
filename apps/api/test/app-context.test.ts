import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

describe('AppModule dependency injection', () => {
  afterEach(() => {
    delete process.env.SETUP_TOKEN;
    delete process.env.APP_ORIGIN;
    delete process.env.APP_ENCRYPTION_KEY;
  });

  it('constructs the full application context', async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.TYPESENSE_URL = 'http://localhost:8108';
    process.env.TYPESENSE_API_KEY = 'test-key';
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.SETUP_TOKEN = 'test-setup-token-value';
    process.env.APP_ORIGIN = 'http://localhost:3000';

    const application = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    expect(application).toBeDefined();
    await application.close();
  });
});
