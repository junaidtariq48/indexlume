import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateSearchIndexRequest,
  IndexField,
  PlaygroundSearchRequest,
  UpdateSearchIndexRequest,
  WorkspaceRole,
} from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole } from '../workspaces/access.js';
import { demoProductDocuments } from './demo-fixture.js';
import { TypesenseConnectionsService } from './typesense-connections.service.js';
import { TypesenseGateway } from './typesense.gateway.js';

interface StoredMapping {
  fields: IndexField[];
  defaultSortingField?: string;
}

@Injectable()
export class SearchIndexesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TypesenseConnectionsService)
    private readonly connections: TypesenseConnectionsService,
    @Inject(TypesenseGateway) private readonly gateway: TypesenseGateway,
  ) {}

  async list(userId: string, projectId: string) {
    await this.findProject(userId, projectId);
    const indexes = await this.prisma.searchIndex.findMany({
      where: { projectId },
      include: { generations: { orderBy: { generation: 'desc' } } },
      orderBy: { name: 'asc' },
    });
    return { data: indexes, meta: {} };
  }

  async get(userId: string, indexId: string) {
    return this.findIndex(userId, indexId);
  }

  async create(
    userId: string,
    projectId: string,
    input: CreateSearchIndexRequest,
  ) {
    const project = await this.findProject(userId, projectId, 'EDITOR');
    if (!project.typesenseConnection) {
      throw new UnprocessableEntityException(
        'Project must be linked to a Typesense connection',
      );
    }
    if (input.fields.some((field) => field.name === 'id')) {
      throw new BadRequestException(
        'The id field is implicit and must not be added to the schema',
      );
    }
    if (input.withDemoData) this.validateDemoSchema(input.fields);

    const alias = `osc_${project.id}_${input.slug}`;
    const generation = 1;
    const physicalCollection = `${alias}_v${generation}`;
    const mapping = {
      fields: input.fields,
      ...(input.defaultSortingField
        ? { defaultSortingField: input.defaultSortingField }
        : {}),
    };
    const searchDefaults = {
      queryBy: input.fields
        .filter((field) => field.searchable)
        .map((field) => field.name),
    };
    const index = await this.prisma.searchIndex.create({
      data: {
        projectId,
        name: input.name,
        slug: input.slug,
        alias,
        mapping,
        searchDefaults,
        generations: {
          create: { generation, physicalCollection },
        },
      },
      include: { generations: true },
    });
    const credentials = this.connections.credentials(
      project.typesenseConnection,
    );

    try {
      await this.gateway.createCollection(credentials, {
        name: physicalCollection,
        fields: input.fields.map((field) => ({
          name: field.name,
          type: field.type,
          facet: field.facet,
          optional: field.optional,
          sort: field.sort,
          index: field.searchable || field.facet || field.sort,
        })),
        ...(input.defaultSortingField
          ? { default_sorting_field: input.defaultSortingField }
          : {}),
      });
      let recordCount = 0;
      if (input.withDemoData) {
        const result = await this.gateway.importDocuments(
          credentials,
          physicalCollection,
          demoProductDocuments,
        );
        if (
          result.failed > 0 ||
          result.succeeded !== demoProductDocuments.length
        ) {
          throw new BadGatewayException(
            'Typesense fixture import was incomplete',
          );
        }
        recordCount = result.succeeded;
      }
      await this.gateway.upsertAlias(credentials, alias, physicalCollection);

      return await this.prisma.$transaction(async (transaction) => {
        await transaction.indexGeneration.update({
          where: {
            searchIndexId_generation: {
              searchIndexId: index.id,
              generation,
            },
          },
          data: { state: 'ACTIVE', recordCount, activatedAt: new Date() },
        });
        const ready = await transaction.searchIndex.update({
          where: { id: index.id },
          data: { state: 'READY', activeGeneration: generation },
          include: { generations: true },
        });
        await transaction.auditLog.create({
          data: {
            workspaceId: project.workspaceId,
            projectId,
            actorId: userId,
            action: 'search_index.created',
            targetType: 'search_index',
            targetId: index.id,
            metadata: { generation, withDemoData: input.withDemoData },
          },
        });
        return ready;
      });
    } catch (error) {
      await Promise.allSettled([
        this.gateway.deleteAlias(credentials, alias),
        this.gateway.deleteCollection(credentials, physicalCollection),
      ]);
      await this.prisma.$transaction([
        this.prisma.searchIndex.update({
          where: { id: index.id },
          data: { state: 'ERROR' },
        }),
        this.prisma.indexGeneration.update({
          where: {
            searchIndexId_generation: {
              searchIndexId: index.id,
              generation,
            },
          },
          data: { state: 'FAILED' },
        }),
      ]);
      throw error;
    }
  }

  async update(
    userId: string,
    indexId: string,
    input: UpdateSearchIndexRequest,
  ) {
    const index = await this.findIndex(userId, indexId, 'EDITOR');
    if (input.searchDefaults) {
      const mapping = index.mapping as unknown as StoredMapping;
      const searchable = new Set(
        mapping.fields
          .filter((field) => field.searchable)
          .map((field) => field.name),
      );
      if (
        input.searchDefaults.queryBy.some((field) => !searchable.has(field))
      ) {
        throw new BadRequestException(
          'Search defaults contain a non-searchable field',
        );
      }
    }
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.searchIndex.update({
        where: { id: indexId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.searchDefaults
            ? { searchDefaults: input.searchDefaults }
            : {}),
        },
        include: { generations: true },
      });
      await transaction.auditLog.create({
        data: {
          workspaceId: index.project.workspaceId,
          projectId: index.projectId,
          actorId: userId,
          action: 'search_index.updated',
          targetType: 'search_index',
          targetId: indexId,
          metadata: { fields: Object.keys(input) },
        },
      });
      return updated;
    });
  }

  async delete(
    userId: string,
    indexId: string,
    confirmation: string | undefined,
  ) {
    const index = await this.findIndex(userId, indexId, 'EDITOR');
    if (confirmation !== index.slug) {
      throw new BadRequestException('Index slug confirmation is required');
    }
    const connection = index.project.typesenseConnection;
    if (!connection) {
      throw new UnprocessableEntityException(
        'Project is not linked to a Typesense connection',
      );
    }
    const credentials = this.connections.credentials(connection);
    await this.gateway.deleteAlias(credentials, index.alias);
    try {
      for (const generation of index.generations) {
        await this.gateway.deleteCollection(
          credentials,
          generation.physicalCollection,
        );
      }
    } catch (error) {
      const active = index.generations.find(
        (generation) => generation.generation === index.activeGeneration,
      );
      if (active) {
        await this.gateway
          .upsertAlias(credentials, index.alias, active.physicalCollection)
          .catch(() => undefined);
      }
      throw error;
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.auditLog.create({
        data: {
          workspaceId: index.project.workspaceId,
          projectId: index.projectId,
          actorId: userId,
          action: 'search_index.deleted',
          targetType: 'search_index',
          targetId: indexId,
        },
      });
      await transaction.searchIndex.delete({ where: { id: indexId } });
    });
    return { success: true };
  }

  async search(
    userId: string,
    indexId: string,
    input: PlaygroundSearchRequest,
  ) {
    const index = await this.findIndex(userId, indexId);
    if (index.state !== 'READY') {
      throw new UnprocessableEntityException('Search index is not ready');
    }
    const connection = index.project.typesenseConnection;
    if (!connection) {
      throw new UnprocessableEntityException(
        'Project is not linked to a Typesense connection',
      );
    }
    const mapping = index.mapping as unknown as StoredMapping;
    this.validateSearch(mapping.fields, input);
    const parameters = new URLSearchParams({
      q: input.q || '*',
      query_by: input.queryBy.join(','),
      page: String(input.page),
      per_page: String(input.perPage),
    });
    if (input.filterBy?.length) {
      parameters.set(
        'filter_by',
        input.filterBy
          .map((filter) => this.compileFilter(mapping.fields, filter))
          .join(' && '),
      );
    }
    if (input.facetBy?.length) {
      parameters.set('facet_by', input.facetBy.join(','));
    }
    if (input.sortBy?.length) {
      parameters.set(
        'sort_by',
        input.sortBy.map((sort) => `${sort.field}:${sort.direction}`).join(','),
      );
    }

    const result = await this.gateway.search(
      this.connections.credentials(connection),
      index.alias,
      parameters,
    );
    return {
      found: result.found ?? 0,
      hits: result.hits ?? [],
      facets: result.facet_counts ?? [],
      page: result.page ?? input.page,
      requestMs: result.search_time_ms ?? 0,
    };
  }

  private async findProject(
    userId: string,
    projectId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        workspace: { memberships: { some: { userId } } },
      },
      include: { typesenseConnection: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    await requireWorkspaceRole(this.prisma, project.workspaceId, userId, role);
    return project;
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
      include: {
        generations: { orderBy: { generation: 'desc' } },
        project: { include: { typesenseConnection: true } },
      },
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

  private validateDemoSchema(fields: IndexField[]): void {
    const expected = new Map([
      ['title', 'string'],
      ['category', 'string'],
      ['price', 'float'],
      ['in_stock', 'bool'],
    ]);
    if (
      [...expected].some(
        ([name, type]) =>
          fields.find((field) => field.name === name)?.type !== type,
      )
    ) {
      throw new BadRequestException(
        'Demo data requires title, category, price, and in_stock fields',
      );
    }
  }

  private validateSearch(
    fields: IndexField[],
    input: PlaygroundSearchRequest,
  ): void {
    const byName = new Map(fields.map((field) => [field.name, field]));
    for (const name of input.queryBy) {
      if (!byName.get(name)?.searchable) {
        throw new BadRequestException(`Field ${name} is not searchable`);
      }
    }
    for (const name of input.facetBy ?? []) {
      if (!byName.get(name)?.facet) {
        throw new BadRequestException(`Field ${name} is not facetable`);
      }
    }
    for (const sort of input.sortBy ?? []) {
      if (!byName.get(sort.field)?.sort) {
        throw new BadRequestException(`Field ${sort.field} is not sortable`);
      }
    }
  }

  private compileFilter(
    fields: IndexField[],
    filter: NonNullable<PlaygroundSearchRequest['filterBy']>[number],
  ): string {
    const field = fields.find((candidate) => candidate.name === filter.field);
    if (!field?.facet) {
      throw new BadRequestException(`Field ${filter.field} is not filterable`);
    }
    const numeric = ['int32', 'int64', 'float'].includes(field.type);
    if (filter.operator !== 'eq' && !numeric) {
      throw new BadRequestException('Range operators require a numeric field');
    }
    if (numeric && typeof filter.value !== 'number') {
      throw new BadRequestException('Numeric filters require a number');
    }
    if (field.type === 'bool' && typeof filter.value !== 'boolean') {
      throw new BadRequestException('Boolean filters require a boolean');
    }
    const operator = { eq: ':=', gt: ':>', gte: ':>=', lt: ':<', lte: ':<=' }[
      filter.operator
    ];
    const value =
      typeof filter.value === 'string'
        ? `\`${filter.value.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``
        : String(filter.value);
    return `${filter.field}${operator}${value}`;
  }
}
