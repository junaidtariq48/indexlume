import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/app-config.js';
import { EncryptionService } from '../src/typesense/encryption.service.js';
import {
  isPrivateAddress,
  validateExternalTypesenseEndpoint,
} from '../src/typesense/endpoint-policy.js';
import { TypesenseGateway } from '../src/typesense/typesense.gateway.js';

const config = {
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  APP_ENCRYPTION_KEY_PREVIOUS: '',
  SEARCH_KEY_PEPPER_PREVIOUS: '',
  ALLOW_PRIVATE_TYPESENSE: false,
  ALLOW_INSECURE_TYPESENSE: false,
  TYPESENSE_REQUEST_TIMEOUT_MS: 1_000,
} as AppConfig;

afterEach(() => vi.restoreAllMocks());

describe('Typesense credential encryption', () => {
  it('round-trips keys without storing their plaintext and rejects tampering', () => {
    const encryption = new EncryptionService(config);
    const encrypted = encryption.encrypt('secret-master-key');

    expect(encrypted).not.toContain('secret-master-key');
    expect(encryption.decrypt(encrypted)).toBe('secret-master-key');
    const parts = encrypted.split('.');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    ciphertext[0] = ciphertext[0]! ^ 1;
    parts[3] = ciphertext.toString('base64url');
    expect(() => encryption.decrypt(parts.join('.'))).toThrow();
  });

  it('reads existing credentials with a previous key during rotation', () => {
    const previous = new EncryptionService(config);
    const encrypted = previous.encrypt('secret-master-key');
    const rotated = new EncryptionService({
      ...config,
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      APP_ENCRYPTION_KEY_PREVIOUS: config.APP_ENCRYPTION_KEY,
    });

    expect(rotated.decrypt(encrypted)).toBe('secret-master-key');
  });
});

describe('Typesense endpoint policy', () => {
  it('recognizes private, loopback, carrier-grade NAT and mapped addresses', () => {
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('rejects credentials and paths before contacting a host', async () => {
    await expect(
      validateExternalTypesenseEndpoint(
        'https://user:pass@example.com',
        'STRICT',
        config,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validateExternalTypesenseEndpoint(
        'https://example.com/collections',
        'STRICT',
        config,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Typesense gateway', () => {
  it('parses every import line and reports partial failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"success":true}\n{"success":false,"error":"bad"}', {
          status: 200,
        }),
      ),
    );
    const gateway = new TypesenseGateway(config);

    await expect(
      gateway.importDocuments(
        { endpoint: 'https://typesense.example', apiKey: 'hidden' },
        'products',
        [{ id: '1' }, { id: '2' }],
      ),
    ).resolves.toEqual({ succeeded: 1, failed: 1 });
  });

  it('does not expose upstream response bodies on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"message":"master key is secret"}', { status: 401 }),
        ),
    );
    const gateway = new TypesenseGateway(config);

    const error = await gateway
      .health({ endpoint: 'https://typesense.example', apiKey: 'hidden' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(String(error)).not.toContain('master key is secret');
  });
});
