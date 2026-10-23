import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateSearchPresetRequest,
  IndexField,
  PlaygroundSearchRequest,
  UpdateSearchPresetRequest,
  WorkspaceRole,
} from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole } from '../workspaces/access.js';

interface StoredMapping {
  fields: IndexField[];
}

@Injectable()
export class SearchPresetsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string, indexId: string) {
    await this.findIndex(userId, indexId);
    const presets = await this.prisma.searchPreset.findMany({
      where: { searchIndexId: indexId },
      include: { createdBy: { select: { id: true, email: true } } },
      orderBy: { name: 'asc' },
    });
    return { data: presets, meta: {} };
  }

  async create(
    userId: string,
    indexId: string,
    input: CreateSearchPresetRequest,
  ) {
    const index = await this.findIndex(userId, indexId, 'EDITOR');
    this.validateSettings(
      index.mapping as unknown as StoredMapping,
      input.settings,
    );
    return this.prisma.$transaction(async (transaction) => {
      const preset = await transaction.searchPreset.create({
        data: {
          searchIndexId: indexId,
          name: input.name,
          settings: input.settings,
          createdById: userId,
        },
        include: { createdBy: { select: { id: true, email: true } } },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: index.project.workspaceId,
          projectId: index.projectId,
          actorId: userId,
          action: 'search_preset.created',
          targetType: 'search_preset',
          targetId: preset.id,
          metadata: { name: preset.name, indexId },
        },
      });
      return preset;
    });
  }

  async update(
    userId: string,
    presetId: string,
    input: UpdateSearchPresetRequest,
  ) {
    const preset = await this.findPreset(userId, presetId, 'EDITOR');
    if (input.settings) {
      this.validateSettings(
        preset.searchIndex.mapping as unknown as StoredMapping,
        input.settings,
      );
    }
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.searchPreset.update({
        where: { id: presetId },
        data: input,
        include: { createdBy: { select: { id: true, email: true } } },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: preset.searchIndex.project.workspaceId,
          projectId: preset.searchIndex.projectId,
          actorId: userId,
          action: 'search_preset.updated',
          targetType: 'search_preset',
          targetId: presetId,
          metadata: { fields: Object.keys(input) },
        },
      });
      return updated;
    });
  }

  async delete(userId: string, presetId: string) {
    const preset = await this.findPreset(userId, presetId, 'EDITOR');
    await this.prisma.$transaction(async (transaction) => {
      await transaction.auditLog.create({
        data: {
          workspaceId: preset.searchIndex.project.workspaceId,
          projectId: preset.searchIndex.projectId,
          actorId: userId,
          action: 'search_preset.deleted',
          targetType: 'search_preset',
          targetId: presetId,
          metadata: { name: preset.name },
        },
      });
      await transaction.searchPreset.delete({ where: { id: presetId } });
    });
    return { success: true };
  }

  private validateSettings(
    mapping: StoredMapping,
    settings: PlaygroundSearchRequest,
  ): void {
    const fields = new Map(mapping.fields.map((field) => [field.name, field]));
    for (const name of settings.queryBy) {
      if (!fields.get(name)?.searchable)
        throw new BadRequestException(`Field ${name} is not searchable`);
    }
    for (const filter of settings.filterBy ?? []) {
      const field = fields.get(filter.field);
      if (!field?.facet)
        throw new BadRequestException(
          `Field ${filter.field} is not filterable`,
        );
      const numeric = ['int32', 'int64', 'float'].includes(field.type);
      if (filter.operator !== 'eq' && !numeric)
        throw new BadRequestException(
          'Range operators require a numeric field',
        );
      if (numeric && typeof filter.value !== 'number')
        throw new BadRequestException('Numeric filters require a number');
      if (field.type === 'bool' && typeof filter.value !== 'boolean')
        throw new BadRequestException('Boolean filters require a boolean');
    }
    for (const name of settings.facetBy ?? []) {
      if (!fields.get(name)?.facet)
        throw new BadRequestException(`Field ${name} is not facetable`);
    }
    for (const sort of settings.sortBy ?? []) {
      if (!fields.get(sort.field)?.sort)
        throw new BadRequestException(`Field ${sort.field} is not sortable`);
    }
  }

  private async findIndex(
    userId: string,
    indexId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const index = await this.prisma.searchIndex.findFirst({
      where: {
        id: indexId,
        project: { workspace: { memberships: { some: { userId } } } },
      },
      include: { project: true },
    });
    if (!index) throw new NotFoundException('Search index not found');
    await requireWorkspaceRole(
      this.prisma,
      index.project.workspaceId,
      userId,
      role,
    );
    return index;
  }

  private async findPreset(
    userId: string,
    presetId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const preset = await this.prisma.searchPreset.findFirst({
      where: {
        id: presetId,
        searchIndex: {
          project: { workspace: { memberships: { some: { userId } } } },
        },
      },
      include: { searchIndex: { include: { project: true } } },
    });
    if (!preset) throw new NotFoundException('Search preset not found');
    await requireWorkspaceRole(
      this.prisma,
      preset.searchIndex.project.workspaceId,
      userId,
      role,
    );
    return preset;
  }
}
