import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { AppConfig } from '../app-config.js';
import { isPrivateAddress } from '../typesense/endpoint-policy.js';

export async function validatePostgresUrl(
  value: string,
  tlsPolicy: 'STRICT' | 'ALLOW_INSECURE',
  config: AppConfig,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('PostgreSQL connection URL is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new BadRequestException(
      'PostgreSQL connection URL must use postgres or postgresql',
    );
  }
  if (!url.username || !url.password || url.pathname.length < 2) {
    throw new BadRequestException(
      'PostgreSQL connection URL must include credentials and a database',
    );
  }
  if (url.hash) {
    throw new BadRequestException(
      'PostgreSQL connection URL must not contain a fragment',
    );
  }
  if (tlsPolicy === 'ALLOW_INSECURE' && !config.ALLOW_INSECURE_POSTGRES) {
    throw new BadRequestException(
      'Insecure PostgreSQL connections are disabled',
    );
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException(
      'PostgreSQL endpoint hostname could not be resolved',
    );
  }
  if (!addresses.length) {
    throw new BadRequestException(
      'PostgreSQL endpoint hostname could not be resolved',
    );
  }
  for (const { address } of addresses) {
    if (isAlwaysBlockedPostgresAddress(address)) {
      throw new BadRequestException(
        'PostgreSQL endpoint resolves to a blocked address',
      );
    }
    if (!config.ALLOW_PRIVATE_POSTGRES && isPrivateAddress(address)) {
      throw new BadRequestException(
        'Private PostgreSQL endpoints are disabled',
      );
    }
  }
  return url.toString();
}

export function isAlwaysBlockedPostgresAddress(address: string): boolean {
  const mapped = mappedIpv4Address(address);
  if (mapped) return isAlwaysBlockedPostgresAddress(mapped);
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
}

function mappedIpv4Address(address: string): string | undefined {
  const normalized = address.toLowerCase();
  if (!normalized.startsWith('::ffff:')) return undefined;
  const value = normalized.slice(7);
  if (isIP(value) === 4) return value;
  const parts = value.split(':');
  if (parts.length !== 2) return undefined;
  const high = Number.parseInt(parts[0] ?? '', 16);
  const low = Number.parseInt(parts[1] ?? '', 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return undefined;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
