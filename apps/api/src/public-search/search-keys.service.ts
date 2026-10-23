import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateSearchKeyRequest } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole } from '../workspaces/access.js';
import { issueSearchKey } from './search-key.crypto.js';

@Injectable()
export class SearchKeysService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(userId: string, projectId: string) {
    await this.findProject(userId, projectId);
    const keys = await this.prisma.searchApiKey.findMany({
      where: { projectId },
      select: {
        id: true,
        label: true,
        keyPrefix: true,
        revokedAt: true,
        lastUsedAt: true,
        rateLimitOverride: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { data: keys, meta: {} };
  }

  async create(
    userId: string,
    projectId: string,
    input: CreateSearchKeyRequest,
  ) {
    const project = await this.findProject(userId, projectId, 'ADMIN');
    const issued = issueSearchKey(
      this.config.SEARCH_KEY_PEPPER ??
        this.config.APP_HMAC_KEY ??
        this.config.APP_ENCRYPTION_KEY,
    );
    const key = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.searchApiKey.create({
        data: {
          projectId,
          label: input.label,
          keyPrefix: issued.prefix,
          keyHash: issued.hash,
          rateLimitOverride: input.rateLimitOverride,
        },
        select: {
          id: true,
          label: true,
          keyPrefix: true,
          revokedAt: true,
          lastUsedAt: true,
          rateLimitOverride: true,
          createdAt: true,
        },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: project.workspaceId,
          projectId,
          actorId: userId,
          action: 'search_api_key.created',
          targetType: 'search_api_key',
          targetId: created.id,
          metadata: { label: created.label },
        },
      });
      return created;
    });
    return { ...key, secret: issued.secret };
  }

  async revoke(userId: string, keyId: string) {
    const key = await this.prisma.searchApiKey.findFirst({
      where: {
        id: keyId,
        project: { workspace: { memberships: { some: { userId } } } },
      },
      include: { project: true },
    });
    if (!key) throw new NotFoundException('Search key not found');
    await requireWorkspaceRole(
      this.prisma,
      key.project.workspaceId,
      userId,
      'ADMIN',
    );
    if (key.revokedAt) return { success: true };
    await this.prisma.$transaction([
      this.prisma.searchApiKey.update({
        where: { id: keyId },
        data: { revokedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: {
          workspaceId: key.project.workspaceId,
          projectId: key.projectId,
          actorId: userId,
          action: 'search_api_key.revoked',
          targetType: 'search_api_key',
          targetId: key.id,
        },
      }),
    ]);
    return { success: true };
  }

  private async findProject(
    userId: string,
    projectId: string,
    role: 'VIEWER' | 'ADMIN' = 'VIEWER',
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        workspace: { memberships: { some: { userId } } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    await requireWorkspaceRole(this.prisma, project.workspaceId, userId, role);
    return project;
  }
}
