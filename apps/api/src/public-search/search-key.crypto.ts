import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_MARKER = 'osc_sk_';

export function issueSearchKey(pepper: string): {
  secret: string;
  prefix: string;
  hash: string;
} {
  const secret = `${KEY_MARKER}${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    prefix: secret.slice(0, KEY_MARKER.length + 8),
    hash: hashSearchKey(secret, pepper),
  };
}

export function hashSearchKey(secret: string, pepper: string): string {
  return createHmac('sha256', Buffer.from(pepper, 'base64'))
    .update(secret)
    .digest('hex');
}

export function searchKeyHashMatches(
  actual: string,
  expected: string,
): boolean {
  const actualBytes = Buffer.from(actual, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function parseBearerSearchKey(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) return '';
  const value = header.slice(7);
  return /^osc_sk_[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}
