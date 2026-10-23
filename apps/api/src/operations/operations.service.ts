import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AnalyticsQuery, AuditQuery } from '@osc/contracts';
import type { PrismaClient } from '@osc/db';

import { PRISMA } from '../infrastructure/tokens.js';
import { requireWorkspaceRole } from '../workspaces/access.js';
import {
  addHistogram,
  analyticsInterval,
  emptyHistogram,
  estimatePercentile,
  truncateAnalyticsBucket,
  type HistogramBucket,
} from './analytics.js';

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

@Injectable()
export class OperationsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async analytics(userId: string, projectId: string, query: AnalyticsQuery) {
    await this.findProject(userId, projectId);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (from >= to) throw new BadRequestException('from must be before to');
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new BadRequestException('Analytics range cannot exceed 90 days');
    }

    const [
      buckets,
      indexes,
      sources,
      activeRuns,
      failedRuns,
      lastSuccess,
      lastError,
    ] = await Promise.all([
      this.prisma.searchMetricBucket.findMany({
        where: { projectId, bucketStart: { gte: from, lte: to } },
        orderBy: { bucketStart: 'asc' },
      }),
      this.prisma.searchIndex.findMany({
        where: { projectId },
        include: { generations: true },
      }),
      this.prisma.dataSource.findMany({
        where: { projectId },
        select: { state: true, errorCount: true },
      }),
      this.prisma.ingestionRun.count({
        where: {
          searchIndex: { projectId },
          status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] },
        },
      }),
      this.prisma.ingestionRun.count({
        where: {
          searchIndex: { projectId },
          status: { in: ['FAILED', 'PARTIAL_FAILED'] },
        },
      }),
      this.prisma.ingestionRun.findFirst({
        where: { searchIndex: { projectId }, status: 'SUCCEEDED' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      }),
      this.prisma.ingestionRun.findFirst({
        where: {
          searchIndex: { projectId },
          status: { in: ['FAILED', 'PARTIAL_FAILED'] },
        },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, errorSummary: true },
      }),
    ]);

    const durationMs = to.getTime() - from.getTime();
    const interval = analyticsInterval(durationMs);
    const grouped = new Map<string, HistogramBucket>();
    const total = emptyHistogram();
    for (const bucket of buckets) {
      const start = truncateAnalyticsBucket(bucket.bucketStart, interval);
      const key = start.toISOString();
      const value: HistogramBucket = {
        count: bucket.count,
        errorCount: bucket.errorCount,
        durationSumMs: bucket.durationSumMs,
        durationLe10: bucket.durationLe10,
        durationLe25: bucket.durationLe25,
        durationLe50: bucket.durationLe50,
        durationLe100: bucket.durationLe100,
        durationLe250: bucket.durationLe250,
        durationLe500: bucket.durationLe500,
        durationLe1000: bucket.durationLe1000,
      };
      addHistogram(total, value);
      const aggregate = grouped.get(key) ?? emptyHistogram();
      addHistogram(aggregate, value);
      grouped.set(key, aggregate);
    }

    const series = [...grouped.entries()].map(([bucketStart, value]) => ({
      bucketStart,
      requests: value.count,
      errors: value.errorCount,
      p50Ms: estimatePercentile(value, 0.5),
      p95Ms: estimatePercentile(value, 0.95),
    }));
    const indexedDocuments = indexes.reduce((sum, index) => {
      const active = index.generations.find(
        (generation) => generation.generation === index.activeGeneration,
      );
      return sum + (active?.recordCount ?? 0);
    }, 0);

    return {
      range: { from: from.toISOString(), to: to.toISOString(), interval },
      hasData: total.count > 0,
      summary: {
        requests: total.count,
        errors: total.errorCount,
        errorRate: total.count ? total.errorCount / total.count : null,
        averageMs: total.count ? total.durationSumMs / total.count : null,
        p50Ms: estimatePercentile(total, 0.5),
        p95Ms: estimatePercentile(total, 0.95),
      },
      series,
      operations: {
        indexCount: indexes.length,
        indexedDocuments,
        sourceCount: sources.length,
        sourceErrors: sources.reduce(
          (sum, source) => sum + source.errorCount,
          0,
        ),
        unhealthySources: sources.filter((source) => source.state === 'ERROR')
          .length,
        activeRuns,
        failedRuns,
        lastSuccessAt: lastSuccess?.finishedAt ?? null,
        lastErrorAt: lastError?.finishedAt ?? null,
        lastError: lastError?.errorSummary ?? null,
      },
      privacy: { queryTermsCollected: false },
    };
  }

  async audit(userId: string, projectId: string, query: AuditQuery) {
    await this.findProject(userId, projectId);
    if (query.cursor) {
      const cursor = await this.prisma.auditLog.findFirst({
        where: { id: query.cursor, projectId },
        select: { id: true },
      });
      if (!cursor) throw new BadRequestException('Invalid audit cursor');
    }
    const entries = await this.prisma.auditLog.findMany({
      where: { projectId },
      include: { actor: { select: { id: true, email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = entries.length > query.limit;
    const data = entries.slice(0, query.limit);
    return {
      data,
      meta: { nextCursor: hasMore ? data.at(-1)?.id : undefined },
    };
  }

  private async findProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        workspace: { memberships: { some: { userId } } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    await requireWorkspaceRole(this.prisma, project.workspaceId, userId);
    return project;
  }
}
