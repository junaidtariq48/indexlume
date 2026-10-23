import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { SetupOwnerRequest } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';
import { createHash, timingSafeEqual } from 'node:crypto';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA } from '../infrastructure/tokens.js';
import { hashPassword } from './password.js';

@Injectable()
export class SetupService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async status(): Promise<{ needsSetup: boolean }> {
    const installed = await this.prisma.platformSetting.findUnique({
      where: { key: 'installed' },
    });
    return { needsSetup: !installed };
  }

  async createOwner(input: SetupOwnerRequest, setupToken?: string) {
    if (!setupToken || !this.tokensMatch(setupToken, this.config.SETUP_TOKEN)) {
      throw new ForbiddenException('Invalid setup token');
    }

    const passwordHash = await hashPassword(input.password);
    const email = input.email.trim().toLowerCase();

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('open_search_console_owner_setup'))`;
      const [installed, userCount] = await Promise.all([
        transaction.platformSetting.findUnique({ where: { key: 'installed' } }),
        transaction.user.count(),
      ]);
      if (installed || userCount > 0) {
        throw new ConflictException('Setup has already been completed');
      }

      const user = await transaction.user.create({
        data: { email, passwordHash },
        select: { id: true, email: true, createdAt: true },
      });
      await transaction.platformSetting.create({
        data: { key: 'installed', value: { completed: true } },
      });
      return { user };
    });
  }

  private tokensMatch(actual: string, expected: string): boolean {
    const actualHash = createHash('sha256').update(actual).digest();
    const expectedHash = createHash('sha256').update(expected).digest();
    return timingSafeEqual(actualHash, expectedHash);
  }
}
