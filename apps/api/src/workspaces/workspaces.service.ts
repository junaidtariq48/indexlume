import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateMemberRequest,
  CreateWorkspaceRequest,
  UpdateMemberRequest,
  UpdateWorkspaceRequest,
} from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { hashPassword } from '../auth/password.js';
import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole, roleAllows } from './access.js';

@Injectable()
export class WorkspacesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string) {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { workspace: { name: 'asc' } },
    });
    return {
      data: memberships.map(({ workspace, role }) => ({ ...workspace, role })),
      meta: {},
    };
  }

  async create(userId: string, input: CreateWorkspaceRequest) {
    return this.prisma.$transaction(async (transaction) => {
      const workspace = await transaction.workspace.create({
        data: { ...input, ownerUserId: userId },
      });
      await transaction.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId, role: 'OWNER' },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: workspace.id,
          actorId: userId,
          action: 'workspace.created',
          targetType: 'workspace',
          targetId: workspace.id,
        },
      });
      return { ...workspace, role: 'OWNER' as const };
    });
  }

  async get(userId: string, workspaceId: string) {
    const membership = await requireWorkspaceRole(
      this.prisma,
      workspaceId,
      userId,
    );
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    return { ...workspace, role: membership.role };
  }

  async update(
    userId: string,
    workspaceId: string,
    input: UpdateWorkspaceRequest,
  ) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId, 'ADMIN');
    return this.prisma.$transaction(async (transaction) => {
      const workspace = await transaction.workspace.update({
        where: { id: workspaceId },
        data: input,
      });
      await transaction.auditLog.create({
        data: {
          workspaceId,
          actorId: userId,
          action: 'workspace.updated',
          targetType: 'workspace',
          targetId: workspaceId,
          metadata: { fields: Object.keys(input) },
        },
      });
      return workspace;
    });
  }

  async listMembers(userId: string, workspaceId: string) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId);
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, email: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return { data: memberships, meta: {} };
  }

  async createMember(
    userId: string,
    workspaceId: string,
    input: CreateMemberRequest,
  ) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId, 'ADMIN');
    const email = input.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('A user with this email already exists');
    }
    const passwordHash = await hashPassword(input.password);

    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: { email, passwordHash },
      });
      const membership = await transaction.workspaceMembership.create({
        data: { workspaceId, userId: user.id, role: input.role },
        include: { user: { select: { id: true, email: true, status: true } } },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId,
          actorId: userId,
          action: 'workspace.member_created',
          targetType: 'workspace_membership',
          targetId: membership.id,
          metadata: { role: membership.role },
        },
      });
      return membership;
    });
  }

  async updateMember(
    userId: string,
    workspaceId: string,
    memberId: string,
    input: UpdateMemberRequest,
  ) {
    const actor = await requireWorkspaceRole(
      this.prisma,
      workspaceId,
      userId,
      'ADMIN',
    );
    const target = await this.prisma.workspaceMembership.findFirst({
      where: { id: memberId, workspaceId },
    });
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    if (target.role === 'OWNER') {
      throw new ForbiddenException('The workspace owner cannot be reassigned');
    }
    if (!roleAllows(actor.role, input.role)) {
      throw new ForbiddenException('Cannot assign a role above your own');
    }

    return this.prisma.$transaction(async (transaction) => {
      const membership = await transaction.workspaceMembership.update({
        where: { id: memberId },
        data: { role: input.role },
        include: { user: { select: { id: true, email: true, status: true } } },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId,
          actorId: userId,
          action: 'workspace.member_updated',
          targetType: 'workspace_membership',
          targetId: memberId,
          metadata: { role: input.role },
        },
      });
      return membership;
    });
  }

  async deleteMember(userId: string, workspaceId: string, memberId: string) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId, 'ADMIN');
    const target = await this.prisma.workspaceMembership.findFirst({
      where: { id: memberId, workspaceId },
      include: { workspace: true },
    });
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    if (target.userId === target.workspace.ownerUserId) {
      throw new ForbiddenException('The workspace owner cannot be removed');
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.workspaceMembership.delete({ where: { id: memberId } });
      await transaction.auditLog.create({
        data: {
          workspaceId,
          actorId: userId,
          action: 'workspace.member_deleted',
          targetType: 'workspace_membership',
          targetId: memberId,
        },
      });
    });
    return { success: true };
  }
}
