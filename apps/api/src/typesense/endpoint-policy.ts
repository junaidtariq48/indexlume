import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { AppConfig } from '../app-config.js';

export async function validateExternalTypesenseEndpoint(
  value: string,
  tlsPolicy: 'STRICT' | 'ALLOW_INSECURE',
  config: AppConfig,
): Promise<string> {
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new BadRequestException('Typesense endpoint must use HTTP or HTTPS');
  }
  if (endpoint.username || endpoint.password) {
    throw new BadRequestException(
      'Endpoint credentials are not allowed in the URL',
    );
  }
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new BadRequestException(
      'Typesense endpoint must not contain a path, query, or fragment',
    );
  }
  if (
    endpoint.protocol !== 'https:' &&
    (tlsPolicy !== 'ALLOW_INSECURE' || !config.ALLOW_INSECURE_TYPESENSE)
  ) {
    throw new BadRequestException(
      'External Typesense endpoints must use HTTPS',
    );
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(endpoint.hostname, { all: true, verbatim: true });
  } catch {
    throw new BadRequestException(
      'Typesense endpoint hostname could not be resolved',
    );
  }
  if (!addresses.length) {
    throw new BadRequestException(
      'Typesense endpoint hostname could not be resolved',
    );
  }
  for (const { address } of addresses) {
    if (isAlwaysBlocked(address)) {
      throw new BadRequestException(
        'Typesense endpoint resolves to a blocked address',
      );
    }
    if (!config.ALLOW_PRIVATE_TYPESENSE && isPrivateAddress(address)) {
      throw new BadRequestException('Private Typesense endpoints are disabled');
    }
  }

  return endpoint.origin;
}

export function isPrivateAddress(address: string): boolean {
  const mapped = mappedIpv4Address(address);
  if (mapped) return isPrivateAddress(mapped);
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  );
}

function isAlwaysBlocked(address: string): boolean {
  const mapped = mappedIpv4Address(address);
  if (mapped) return isAlwaysBlocked(mapped);
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
