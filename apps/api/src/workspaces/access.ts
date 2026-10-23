import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { WorkspaceRole } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

const roleRank: Record<WorkspaceRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function roleAllows(
  actual: WorkspaceRole,
  required: WorkspaceRole,
): boolean {
  return roleRank[actual] >= roleRank[required];
}

export async function requireWorkspaceRole(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  required: WorkspaceRole = 'VIEWER',
) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership) {
    throw new NotFoundException('Workspace not found');
  }
  if (!roleAllows(membership.role, required)) {
    throw new ForbiddenException('Insufficient workspace permission');
  }
  return membership;
}
