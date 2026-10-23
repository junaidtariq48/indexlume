import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { IndexField, PublicSearchRequest } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { PRISMA } from '../infrastructure/tokens.js';
import { TypesenseConnectionsService } from '../typesense/typesense-connections.service.js';
import { TypesenseGateway } from '../typesense/typesense.gateway.js';
import { compilePublicFilters } from './filter-compiler.js';

interface StoredMapping {
  fields: IndexField[];
}

@Injectable()
export class PublicSearchService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TypesenseConnectionsService)
    private readonly connections: TypesenseConnectionsService,
    @Inject(TypesenseGateway) private readonly gateway: TypesenseGateway,
  ) {}

  async search(
    projectId: string,
    indexSlug: string,
    input: PublicSearchRequest,
  ) {
    const index = await this.prisma.searchIndex.findFirst({
      where: { projectId, slug: indexSlug },
      include: { project: { include: { typesenseConnection: true } } },
    });
    if (!index) throw new NotFoundException('Search index not found');
    if (index.state !== 'READY') {
      throw new UnprocessableEntityException('Search index is not ready');
    }
    if (!index.project.typesenseConnection) {
      throw new UnprocessableEntityException(
        'Project is not linked to a Typesense connection',
      );
    }
    const mapping = index.mapping as unknown as StoredMapping;
    const started = Date.now();
    let failed = false;
    try {
      const defaults = index.searchDefaults as { queryBy?: string[] };
      const queryBy = (defaults.queryBy ?? []).filter((name) =>
        mapping.fields.some((field) => field.name === name && field.searchable),
      );
      if (!queryBy.length) {
        throw new UnprocessableEntityException(
          'Search index has no searchable default fields',
        );
      }
      this.validateFields(mapping.fields, input);
      const returnFields = mapping.fields.map((field) => field.name);
      const parameters = new URLSearchParams({
        q: input.q || '*',
        query_by: queryBy.join(','),
        include_fields: ['id', ...returnFields].join(','),
        page: String(input.page),
        per_page: String(input.perPage),
      });
      if (input.filter?.length) {
        parameters.set(
          'filter_by',
          compilePublicFilters(mapping.fields, input.filter),
        );
      }
      if (input.facets?.length)
        parameters.set('facet_by', input.facets.join(','));
      if (input.sort?.length) {
        parameters.set(
          'sort_by',
          input.sort.map((sort) => `${sort.field}:${sort.direction}`).join(','),
        );
      }
      const result = await this.gateway.search(
        this.connections.credentials(index.project.typesenseConnection),
        index.alias,
        parameters,
      );
      const hits = Array.isArray(result.hits) ? result.hits : [];
      return {
        hits: hits.map((value) => {
          const hit = value as {
            document?: Record<string, unknown>;
            highlights?: unknown;
            highlight?: unknown;
          };
          const source = hit.document ?? {};
          const document = Object.fromEntries(
            ['id', ...returnFields]
              .filter((field) => Object.hasOwn(source, field))
              .map((field) => [field, source[field]]),
          );
          return {
            id: String(source.id ?? ''),
            document,
            highlights: hit.highlights ?? hit.highlight ?? [],
          };
        }),
        found: Number(result.found ?? 0),
        page: Number(result.page ?? input.page),
        perPage: input.perPage,
        facets: result.facet_counts ?? [],
        requestMs: Number(result.search_time_ms ?? Date.now() - started),
      };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await this.recordMetric(
        projectId,
        index.id,
        Date.now() - started,
        failed,
      );
    }
  }

  private validateFields(
    fields: IndexField[],
    input: PublicSearchRequest,
  ): void {
    const byName = new Map(fields.map((field) => [field.name, field]));
    for (const facet of input.facets ?? []) {
      if (!byName.get(facet)?.facet) {
        throw new UnprocessableEntityException(
          `Field ${facet} is not facetable`,
        );
      }
    }
    for (const sort of input.sort ?? []) {
      if (!byName.get(sort.field)?.sort) {
        throw new UnprocessableEntityException(
          `Field ${sort.field} is not sortable`,
        );
      }
    }
  }

  private async recordMetric(
    projectId: string,
    searchIndexId: string,
    durationMs: number,
    failed: boolean,
  ): Promise<void> {
    const now = new Date();
    const bucketStart = new Date(now);
    bucketStart.setUTCSeconds(0, 0);
    const histogram = {
      ...(durationMs <= 10 ? { durationLe10: { increment: 1 } } : {}),
      ...(durationMs <= 25 ? { durationLe25: { increment: 1 } } : {}),
      ...(durationMs <= 50 ? { durationLe50: { increment: 1 } } : {}),
      ...(durationMs <= 100 ? { durationLe100: { increment: 1 } } : {}),
      ...(durationMs <= 250 ? { durationLe250: { increment: 1 } } : {}),
      ...(durationMs <= 500 ? { durationLe500: { increment: 1 } } : {}),
      ...(durationMs <= 1000 ? { durationLe1000: { increment: 1 } } : {}),
    };
    await this.prisma.searchMetricBucket
      .upsert({
        where: {
          projectId_searchIndexId_bucketStart: {
            projectId,
            searchIndexId,
            bucketStart,
          },
        },
        create: {
          projectId,
          searchIndexId,
          bucketStart,
          count: 1,
          errorCount: failed ? 1 : 0,
          durationSumMs: durationMs,
          durationLe10: durationMs <= 10 ? 1 : 0,
          durationLe25: durationMs <= 25 ? 1 : 0,
          durationLe50: durationMs <= 50 ? 1 : 0,
          durationLe100: durationMs <= 100 ? 1 : 0,
          durationLe250: durationMs <= 250 ? 1 : 0,
          durationLe500: durationMs <= 500 ? 1 : 0,
          durationLe1000: durationMs <= 1000 ? 1 : 0,
        },
        update: {
          count: { increment: 1 },
          errorCount: { increment: failed ? 1 : 0 },
          durationSumMs: { increment: durationMs },
          ...histogram,
        },
      })
      .catch(() => undefined);
  }
}
