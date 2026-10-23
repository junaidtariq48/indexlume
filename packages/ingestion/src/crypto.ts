import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const ACTIVE_VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const KEY_BYTES = 32;

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('Encryption keys must be base64-encoded 32-byte values');
  }
  return key;
}

function keyId(key: Buffer): string {
  return createHash('sha256')
    .update(key)
    .digest()
    .subarray(0, 8)
    .toString('base64url');
}

export function encryptionKeyring(
  activeKey: string,
  previousKeys = '',
): Buffer[] {
  const encoded = [
    activeKey,
    ...previousKeys
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  const unique = new Map<string, Buffer>();
  for (const value of encoded) {
    const key = decodeKey(value);
    unique.set(keyId(key), key);
  }
  return [...unique.values()];
}

export function activeEncryptionKeyId(activeKey: string): string {
  return keyId(decodeKey(activeKey));
}

export function encryptEnvelope(
  purpose: string,
  plaintext: string | Buffer,
  activeKey: string,
): string {
  const key = decodeKey(activeKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(
    Buffer.from(`open-search-console:${purpose}:${ACTIVE_VERSION}`),
  );
  const ciphertext = Buffer.concat([
    cipher.update(
      typeof plaintext === 'string'
        ? Buffer.from(plaintext, 'utf8')
        : plaintext,
    ),
    cipher.final(),
  ]);
  return [ACTIVE_VERSION, keyId(key), nonce, cipher.getAuthTag(), ciphertext]
    .map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    )
    .join('.');
}

export function decryptEnvelope(
  purpose: string,
  envelope: string,
  activeKey: string,
  previousKeys = '',
): Buffer {
  const parts = envelope.split('.');
  const version = parts[0];
  const keyring = encryptionKeyring(activeKey, previousKeys);
  if (version === ACTIVE_VERSION) {
    const [, envelopeKeyId, nonce, tag, ciphertext] = parts;
    if (!envelopeKeyId || !nonce || !tag || !ciphertext) {
      throw new Error('Invalid encrypted envelope');
    }
    const key = keyring.find((candidate) => keyId(candidate) === envelopeKeyId);
    if (!key) throw new Error('Encrypted value requires an unavailable key');
    return decryptWithKey(purpose, ACTIVE_VERSION, key, nonce, tag, ciphertext);
  }
  if (version === LEGACY_VERSION) {
    const [, nonce, tag, ciphertext] = parts;
    if (!nonce || !tag || !ciphertext) {
      throw new Error('Invalid encrypted envelope');
    }
    for (const key of keyring) {
      try {
        return decryptWithKey(
          purpose,
          LEGACY_VERSION,
          key,
          nonce,
          tag,
          ciphertext,
        );
      } catch {
        // Legacy envelopes have no key identifier, so each configured key is tried.
      }
    }
    throw new Error('Encrypted value requires an unavailable key');
  }
  throw new Error('Unsupported encrypted envelope');
}

export function envelopeKeyId(envelope: string): string | null {
  const [version, id] = envelope.split('.');
  return version === ACTIVE_VERSION && id ? id : null;
}

function decryptWithKey(
  purpose: string,
  version: string,
  key: Buffer,
  nonce: string,
  tag: string,
  ciphertext: string,
): Buffer {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(nonce, 'base64url'),
  );
  decipher.setAAD(Buffer.from(`open-search-console:${purpose}:${version}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]);
}
