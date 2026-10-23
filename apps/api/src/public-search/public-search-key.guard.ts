import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient } from '@osc/db';
import type { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA, REDIS } from '../infrastructure/tokens.js';
import {
  hashSearchKey,
  parseBearerSearchKey,
  searchKeyHashMatches,
} from './search-key.crypto.js';
import type { PublicSearchRequestWithContext } from './public-search.types.js';

@Injectable()
export class PublicSearchKeyGuard implements CanActivate {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<PublicSearchRequestWithContext>();
    const response = http.getResponse<{
      setHeader(name: string, value: string): void;
    }>();
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (contentLength > 16_384) {
      throw new HttpException('Search request payload is too large', 413);
    }
    const secret = parseBearerSearchKey(request.headers.authorization);
    if (!secret) throw new UnauthorizedException('Valid search key required');
    const prefix = secret.slice(0, 'osc_sk_'.length + 8);
    const candidates = await this.prisma.searchApiKey
      .findMany({
        where: {
          keyPrefix: prefix,
          revokedAt: null,
          project: { publicId: String(request.params.projectPublicId ?? '') },
        },
        select: {
          id: true,
          projectId: true,
          keyHash: true,
          rateLimitOverride: true,
        },
      })
      .catch(() => []);
    const peppers = [
      this.config.SEARCH_KEY_PEPPER ??
        this.config.APP_HMAC_KEY ??
        this.config.APP_ENCRYPTION_KEY,
      ...this.config.SEARCH_KEY_PEPPER_PREVIOUS.split(',').filter(Boolean),
    ];
    const actualHashes = peppers.map((pepper) => hashSearchKey(secret, pepper));
    const key = candidates.find((candidate) =>
      actualHashes.some((actualHash) =>
        searchKeyHashMatches(actualHash, candidate.keyHash),
      ),
    );
    if (!key)
      throw new UnauthorizedException('Search key is invalid or revoked');

    const limit =
      key.rateLimitOverride ?? this.config.PUBLIC_SEARCH_RATE_LIMIT_MAX;
    const windowSeconds = this.config.PUBLIC_SEARCH_RATE_LIMIT_WINDOW_SECONDS;
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey = `public-search:${key.projectId}:${window}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) await this.redis.expire(redisKey, windowSeconds + 1);
    const remaining = Math.max(0, limit - count);
    response.setHeader('RateLimit-Limit', String(limit));
    response.setHeader('RateLimit-Remaining', String(remaining));
    if (count > limit) {
      const retryAfter = await this.redis.ttl(redisKey);
      response.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      throw new HttpException('Public search rate limit exceeded', 429);
    }

    request.publicSearch = { keyId: key.id, projectId: key.projectId };
    await this.prisma.searchApiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    });
    return true;
  }
}
