import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateProjectRequest,
  UpdateProjectRequest,
} from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole } from './access.js';

@Injectable()
export class ProjectsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string, workspaceId: string) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId);
    const projects = await this.prisma.project.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
    });
    return { data: projects, meta: {} };
  }

  async create(
    userId: string,
    workspaceId: string,
    input: CreateProjectRequest,
  ) {
    await requireWorkspaceRole(this.prisma, workspaceId, userId, 'ADMIN');
    await this.requireConnectionInWorkspace(
      workspaceId,
      input.typesenseConnectionId,
    );
    return this.prisma.$transaction(async (transaction) => {
      const project = await transaction.project.create({
        data: { ...input, workspaceId },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId,
          projectId: project.id,
          actorId: userId,
          action: 'project.created',
          targetType: 'project',
          targetId: project.id,
        },
      });
      return project;
    });
  }

  async get(userId: string, projectId: string) {
    const project = await this.findScopedProject(userId, projectId);
    return project;
  }

  async update(userId: string, projectId: string, input: UpdateProjectRequest) {
    const project = await this.findScopedProject(userId, projectId, 'ADMIN');
    await this.requireConnectionInWorkspace(
      project.workspaceId,
      input.typesenseConnectionId,
    );
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.project.update({
        where: { id: projectId },
        data: input,
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: project.workspaceId,
          projectId,
          actorId: userId,
          action: 'project.updated',
          targetType: 'project',
          targetId: projectId,
          metadata: { fields: Object.keys(input) },
        },
      });
      return updated;
    });
  }

  async delete(userId: string, projectId: string) {
    const project = await this.findScopedProject(userId, projectId, 'ADMIN');
    await this.prisma.$transaction(async (transaction) => {
      await transaction.auditLog.create({
        data: {
          workspaceId: project.workspaceId,
          actorId: userId,
          action: 'project.deleted',
          targetType: 'project',
          targetId: projectId,
        },
      });
      await transaction.project.delete({ where: { id: projectId } });
    });
    return { success: true };
  }

  private async findScopedProject(
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
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    await requireWorkspaceRole(this.prisma, project.workspaceId, userId, role);
    return project;
  }

  private async requireConnectionInWorkspace(
    workspaceId: string,
    connectionId: string | undefined,
  ): Promise<void> {
    if (!connectionId) return;
    const connection = await this.prisma.typesenseConnection.findFirst({
      where: { id: connectionId, workspaceId },
      select: { id: true },
    });
    if (!connection) {
      throw new NotFoundException('Typesense connection not found');
    }
  }
}
