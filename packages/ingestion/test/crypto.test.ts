import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  activeEncryptionKeyId,
  decryptEnvelope,
  encryptEnvelope,
  envelopeKeyId,
} from '../src/index.js';

const oldKey = Buffer.alloc(32, 3).toString('base64');
const newKey = Buffer.alloc(32, 7).toString('base64');

describe('versioned encryption envelopes', () => {
  it('encrypts with an explicit key id and decrypts with the active key', () => {
    const envelope = encryptEnvelope('projection-root-key', 'secret', newKey);

    expect(envelope).not.toContain('secret');
    expect(envelopeKeyId(envelope)).toBe(activeEncryptionKeyId(newKey));
    expect(
      decryptEnvelope('projection-root-key', envelope, newKey).toString('utf8'),
    ).toBe('secret');
  });

  it('decrypts v2 and legacy v1 values with a previous key during rotation', () => {
    const currentEnvelope = encryptEnvelope(
      'postgres-config',
      'current',
      oldKey,
    );
    const legacyEnvelope = legacyEncrypt('postgres-config', 'legacy', oldKey);

    expect(
      decryptEnvelope(
        'postgres-config',
        currentEnvelope,
        newKey,
        oldKey,
      ).toString('utf8'),
    ).toBe('current');
    expect(
      decryptEnvelope(
        'postgres-config',
        legacyEnvelope,
        newKey,
        oldKey,
      ).toString('utf8'),
    ).toBe('legacy');
  });

  it('fails closed when the required key or purpose is unavailable', () => {
    const envelope = encryptEnvelope('typesense-api-key', 'secret', oldKey);

    expect(() =>
      decryptEnvelope('typesense-api-key', envelope, newKey),
    ).toThrow('unavailable key');
    expect(() =>
      decryptEnvelope('postgres-config', envelope, oldKey),
    ).toThrow();
  });
});

function legacyEncrypt(purpose: string, plaintext: string, keyValue: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(keyValue, 'base64'),
    nonce,
  );
  cipher.setAAD(Buffer.from(`open-search-console:${purpose}:v1`));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return ['v1', nonce, cipher.getAuthTag(), ciphertext]
    .map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    )
    .join('.');
}
