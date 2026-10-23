import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/app-config.js';
import {
  isAlwaysBlockedPostgresAddress,
  validatePostgresUrl,
} from '../src/postgres/postgres-policy.js';
import { EncryptionService } from '../src/typesense/encryption.service.js';

const config = {
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  ALLOW_PRIVATE_POSTGRES: false,
  ALLOW_INSECURE_POSTGRES: false,
} as AppConfig;

describe('PostgreSQL connector security', () => {
  it('uses purpose-bound authenticated encryption for saved configuration', () => {
    const encryption = new EncryptionService(config);
    const plaintext = JSON.stringify({ connectionUrl: 'postgresql://secret' });
    const encrypted = encryption.encryptFor('postgres-config', plaintext);

    expect(encrypted).not.toContain('secret');
    expect(encryption.decryptFor('postgres-config', encrypted)).toBe(plaintext);
    expect(() => encryption.decrypt(encrypted)).toThrow();
  });

  it('rejects non-PostgreSQL and insecure connection URLs before DNS', async () => {
    await expect(
      validatePostgresUrl('https://user:pass@example.com/db', 'STRICT', config),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validatePostgresUrl(
        'postgresql://user:pass@example.com/db',
        'ALLOW_INSECURE',
        config,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('always blocks link-local metadata addresses, including IPv4 mapping', () => {
    expect(isAlwaysBlockedPostgresAddress('169.254.169.254')).toBe(true);
    expect(isAlwaysBlockedPostgresAddress('::ffff:a9fe:a9fe')).toBe(true);
  });
});
