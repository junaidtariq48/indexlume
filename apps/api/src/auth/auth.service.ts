import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { LoginRequest } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA, REDIS } from '../infrastructure/tokens.js';
import { SESSION_COOKIE } from './auth.constants.js';
import { verifyPassword } from './password.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(input: LoginRequest, ip: string, response: Response) {
    const email = input.email.trim().toLowerCase();
    const rateLimitKey = `login:${createHash('sha256').update(`${email}:${ip}`).digest('hex')}`;
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
    const attempts = await this.redis.incr(rateLimitKey);
    if (attempts === 1) {
      await this.redis.expire(
        rateLimitKey,
        this.config.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
      );
    }
    if (attempts > this.config.LOGIN_RATE_LIMIT_MAX) {
      throw new HttpException(
        'Too many login attempts',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !(await verifyPassword(user.passwordHash, input.password))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.redis.del(rateLimitKey);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.config.SESSION_TTL_HOURS * 60 * 60 * 1_000,
    );
    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: this.hashToken(token),
          expiresAt,
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    ]);
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'strict',
      expires: expiresAt,
      path: '/',
    });
    return { user: { id: user.id, email: user.email } };
  }

  async logout(token: string | undefined, response: Response) {
    if (token) {
      await this.prisma.session.deleteMany({
        where: { tokenHash: this.hashToken(token) },
      });
    }
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
    });
    return { success: true };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
