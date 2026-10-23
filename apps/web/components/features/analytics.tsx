'use client';

import { Activity, BarChart3, Radio } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest } from '../../lib/api';
import type { AnalyticsResponse, Project } from '../console-model';
import {
  Empty,
  ErrorState,
  LoadingState,
  Metric,
  Panel,
  formatLatency,
  formatUtc,
} from '../feature-primitives';

const LIVE_REFRESH_OPTIONS = [
  { value: 2_000, label: '2s' },
  { value: 5_000, label: '5s' },
  { value: 60_000, label: '1m' },
] as const;

type LiveRefreshInterval = (typeof LIVE_REFRESH_OPTIONS)[number]['value'];

export function AnalyticsView({ project }: { project?: Project }) {
  const [days, setDays] = useState<1 | 7 | 30 | 90>(7);
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [liveAnalytics, setLiveAnalytics] = useState<AnalyticsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveRefreshInterval, setLiveRefreshInterval] =
    useState<LiveRefreshInterval>(5_000);
  const [error, setError] = useState('');
  const [liveError, setLiveError] = useState('');
  const [liveUpdatedAt, setLiveUpdatedAt] = useState<Date | null>(null);
  const liveRequestInFlight = useRef(false);
  const load = useCallback(async () => {
    if (!project) return setAnalytics(null);
    setLoading(true);
    setError('');
    try {
      setAnalytics(
        await apiRequest<AnalyticsResponse>(
          `/projects/${project.id}/analytics?from=${encodeURIComponent(
            new Date(Date.now() - days * 86_400_000).toISOString(),
          )}&to=${encodeURIComponent(new Date().toISOString())}`,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not load analytics',
      );
    } finally {
      setLoading(false);
    }
  }, [days, project]);
  const loadLive = useCallback(async () => {
    if (!project || liveRequestInFlight.current) return;
    liveRequestInFlight.current = true;
    setLiveLoading(true);
    try {
      const to = new Date();
      to.setUTCSeconds(59, 999);
      const from = new Date(to.getTime() - 29 * 60_000);
      from.setUTCSeconds(0, 0);
      setLiveAnalytics(
        await apiRequest<AnalyticsResponse>(
          `/projects/${project.id}/analytics?from=${encodeURIComponent(
            from.toISOString(),
          )}&to=${encodeURIComponent(to.toISOString())}`,
        ),
      );
      setLiveUpdatedAt(new Date());
      setLiveError('');
    } catch (caught) {
      setLiveError(
        caught instanceof Error
          ? caught.message
          : 'Could not refresh live analytics',
      );
    } finally {
      liveRequestInFlight.current = false;
      setLiveLoading(false);
    }
  }, [project]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void loadLive();
    const timer = window.setInterval(
      () => void loadLive(),
      liveRefreshInterval,
    );
    return () => window.clearInterval(timer);
  }, [liveRefreshInterval, loadLive]);
  if (!project)
    return (
      <Empty
        title="Select a project"
        detail="Choose a project to view analytics."
      />
    );
  if (loading && !analytics) return <LoadingState label="Loading analytics" />;
  if (error && !analytics)
    return (
      <ErrorState
        detail={error}
        onRetry={() => void load()}
        title="Analytics unavailable"
      />
    );
  if (!analytics) return null;
  const maxRequests = Math.max(
    ...analytics.series.map((item) => item.requests),
    1,
  );
  const maxLatency = Math.max(
    ...analytics.series.map((item) => item.p95Ms ?? 0),
    1,
  );
  const liveSeries = buildLiveSeries(liveAnalytics);
  const liveTotal = liveSeries.reduce((sum, point) => sum + point.requests, 0);
  const livePeak = Math.max(...liveSeries.map((point) => point.requests), 0);
  const currentMinute = liveSeries.at(-1)?.requests ?? 0;
  return (
    <div className="space-y-5">
      {error ? (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          Refresh failed: {error}
        </p>
      ) : null}
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-primary">
              Last {days === 1 ? '24 hours' : `${days} days`}
            </p>
            <h2 className="mt-1 text-2xl font-semibold">Search analytics</h2>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div
              aria-label="Analytics date range"
              className="flex rounded-lg border border-border p-1"
              role="radiogroup"
            >
              {([1, 7, 30, 90] as const).map((value) => (
                <label className="cursor-pointer" key={value}>
                  <input
                    checked={days === value}
                    className="peer sr-only"
                    name="analytics-range"
                    onChange={() => setDays(value)}
                    type="radio"
                    value={value}
                  />
                  <span
                    className={`block rounded-md px-3 py-1.5 text-xs font-medium ring-offset-background peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 ${days === value ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {value === 1 ? '24h' : `${value}d`}
                  </span>
                </label>
              ))}
            </div>
            <button
              className="secondary-button"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Requests" value={analytics.summary.requests} />
          <Metric label="Errors" value={analytics.summary.errors} />
          <Metric
            label="p50 latency"
            value={formatLatency(analytics.summary.p50Ms)}
          />
          <Metric
            label="p95 latency"
            value={formatLatency(analytics.summary.p95Ms)}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          UTC range:{' '}
          <time dateTime={analytics.range.from}>
            {formatUtc(analytics.range.from)}
          </time>{' '}
          to{' '}
          <time dateTime={analytics.range.to}>
            {formatUtc(analytics.range.to)}
          </time>
        </p>
      </section>
      <Panel
        title="Live request traffic"
        detail="Real public search requests per minute with a selectable automatic refresh interval."
        icon={Radio}
      >
        <div className="p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-6">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Current minute
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {currentMinute}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Last 30 minutes
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {liveTotal}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Peak per minute
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {livePeak}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Auto refresh
                </span>
                <div
                  aria-label="Live analytics refresh interval"
                  className="flex rounded-lg border border-border p-1"
                  role="radiogroup"
                >
                  {LIVE_REFRESH_OPTIONS.map((option) => (
                    <label className="cursor-pointer" key={option.value}>
                      <input
                        checked={liveRefreshInterval === option.value}
                        className="peer sr-only"
                        name="live-refresh-interval"
                        onChange={() => setLiveRefreshInterval(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span className="block rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground ring-offset-background hover:text-foreground peer-checked:bg-accent peer-checked:text-accent-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2">
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
                <span className="relative flex size-2.5" aria-hidden="true">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-success" />
                </span>
                <span aria-live="polite">
                  {liveLoading
                    ? 'Updating live data…'
                    : liveUpdatedAt
                      ? `Updated ${liveUpdatedAt.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}`
                      : 'Connecting…'}
                </span>
                <button
                  className="secondary-button min-h-8 px-3 py-1 text-xs"
                  disabled={liveLoading}
                  onClick={() => void loadLive()}
                >
                  Refresh now
                </button>
              </div>
            </div>
          </div>
          {liveError ? (
            <p
              className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              Live refresh failed: {liveError}
            </p>
          ) : null}
          <LiveRequestGraph points={liveSeries} />
        </div>
      </Panel>
      <Panel
        title="Request volume"
        detail="Successful and failed public search requests from collected metric buckets."
        icon={BarChart3}
      >
        <div className="p-5">
          {!analytics.hasData ? (
            <div className="py-10 text-center">
              <BarChart3 className="mx-auto size-7 text-muted-foreground" />
              <h3 className="mt-4 font-medium">No search traffic yet</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Use a project search key against the public search endpoint.
                Metrics will appear after the first real query.
              </p>
            </div>
          ) : (
            <div
              className="flex h-56 items-end gap-1"
              role="img"
              aria-label="Search requests by time bucket"
            >
              {analytics.series.map((item) => (
                <div
                  key={item.bucketStart}
                  className="group relative flex h-full min-w-1 flex-1 items-end"
                  title={`${formatUtc(item.bucketStart)}: ${item.requests} requests, ${item.errors} errors`}
                >
                  <div
                    className="w-full rounded-t bg-chart-1/70"
                    style={{
                      height: `${Math.max((item.requests / maxRequests) * 100, 2)}%`,
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span>
              <time
                dateTime={analytics.range.from}
                title={analytics.range.from}
              >
                {formatUtc(analytics.range.from)}
              </time>
            </span>
            <span>
              Error rate:{' '}
              {analytics.summary.errorRate === null
                ? 'No data'
                : `${(analytics.summary.errorRate * 100).toFixed(1)}%`}
            </span>
            <span>
              <time dateTime={analytics.range.to} title={analytics.range.to}>
                {formatUtc(analytics.range.to)}
              </time>
            </span>
          </div>
        </div>
      </Panel>
      <Panel
        title="Operations"
        detail="Current index, source, and ingestion state for this project."
        icon={Activity}
      >
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Indexed documents"
            value={analytics.operations.indexedDocuments}
          />
          <Metric label="Sources" value={analytics.operations.sourceCount} />
          <Metric
            label="Source errors"
            value={analytics.operations.sourceErrors}
          />
          <Metric label="Failed jobs" value={analytics.operations.failedRuns} />
        </div>
      </Panel>
      <Panel
        title="Latency estimates"
        detail="p50 and p95 upper-bound estimates from the same aggregate metric buckets."
        icon={Activity}
      >
        <div className="p-5">
          {!analytics.hasData ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No latency data yet.
            </p>
          ) : (
            <>
              <div
                className="flex h-48 items-end gap-1"
                role="img"
                aria-label="p50 and p95 search latency by time bucket"
              >
                {analytics.series.map((item) => (
                  <div
                    key={item.bucketStart}
                    className="flex h-full min-w-2 flex-1 items-end gap-px"
                    title={`${formatUtc(item.bucketStart)}: p50 ${formatLatency(item.p50Ms)}, p95 ${formatLatency(item.p95Ms)}`}
                  >
                    <div
                      className="w-1/2 rounded-t bg-chart-1/70"
                      style={{
                        height: `${Math.max(((item.p50Ms ?? 0) / maxLatency) * 100, 2)}%`,
                      }}
                    />
                    <div
                      className="w-1/2 rounded-t bg-chart-2/70"
                      style={{
                        height: `${Math.max(((item.p95Ms ?? 0) / maxLatency) * 100, 2)}%`,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-5 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded bg-chart-1" /> p50
                </span>
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded bg-chart-2" /> p95
                </span>
              </div>
              <details className="mt-5 rounded-lg border border-border">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  View accessible series data
                </summary>
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full min-w-[34rem] text-left text-sm">
                    <thead className="bg-muted/60 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">UTC bucket</th>
                        <th className="px-4 py-2 font-medium">Requests</th>
                        <th className="px-4 py-2 font-medium">Errors</th>
                        <th className="px-4 py-2 font-medium">p50</th>
                        <th className="px-4 py-2 font-medium">p95</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {analytics.series.map((item) => (
                        <tr key={item.bucketStart}>
                          <td className="px-4 py-2">
                            <time dateTime={item.bucketStart}>
                              {formatUtc(item.bucketStart)}
                            </time>
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {item.requests}
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {item.errors}
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {formatLatency(item.p50Ms)}
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {formatLatency(item.p95Ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </div>
      </Panel>
      <p className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        Latencies are estimates from aggregated histogram buckets. Metrics
        follow the deployment retention policy. Raw query terms and top-query
        analytics are disabled by default and are not collected.
      </p>
    </div>
  );
}

interface LivePoint {
  bucketStart: string;
  requests: number;
}

function buildLiveSeries(analytics: AnalyticsResponse | null): LivePoint[] {
  if (!analytics) return [];
  const end = new Date(analytics.range.to);
  end.setUTCSeconds(0, 0);
  const requestsByMinute = new Map(
    analytics.series.map((point) => {
      const minute = new Date(point.bucketStart);
      minute.setUTCSeconds(0, 0);
      return [minute.toISOString(), point.requests] as const;
    }),
  );
  return Array.from({ length: 30 }, (_, index) => {
    const bucket = new Date(end.getTime() - (29 - index) * 60_000);
    const bucketStart = bucket.toISOString();
    return {
      bucketStart,
      requests: requestsByMinute.get(bucketStart) ?? 0,
    };
  });
}

function LiveRequestGraph({ points }: { points: LivePoint[] }) {
  if (!points.length) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
        Connecting to live request metrics…
      </div>
    );
  }

  const width = 720;
  const height = 220;
  const chartTop = 18;
  const chartBottom = 180;
  const max = Math.max(...points.map((point) => point.requests), 1);
  const coordinates = points.map((point, index) => ({
    ...point,
    x: (index / (points.length - 1)) * width,
    y: chartBottom - (point.requests / max) * (chartBottom - chartTop),
  }));
  const line = coordinates
    .map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`)
    .join(' ');
  const area = `${line} L ${width} ${chartBottom} L 0 ${chartBottom} Z`;
  const total = points.reduce((sum, point) => sum + point.requests, 0);
  const first = points[0]!;
  const last = points.at(-1)!;

  return (
    <div>
      <div className="relative overflow-hidden rounded-lg border border-border bg-muted/15 px-3 pt-3">
        <div className="pointer-events-none absolute left-4 top-3 text-[11px] tabular-nums text-muted-foreground">
          {max} req/min
        </div>
        <svg
          aria-label={`Live requests for the last 30 minutes: ${total} total requests and a peak of ${max} requests per minute.`}
          className="h-64 w-full"
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <title>Live public search requests per minute</title>
          {[chartTop, (chartTop + chartBottom) / 2, chartBottom].map(
            (position) => (
              <line
                key={position}
                stroke="var(--border)"
                strokeDasharray="4 5"
                vectorEffect="non-scaling-stroke"
                x1="0"
                x2={width}
                y1={position}
                y2={position}
              />
            ),
          )}
          <path d={area} fill="var(--chart-1)" fillOpacity="0.14" />
          <path
            d={line}
            fill="none"
            stroke="var(--chart-1)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
          {coordinates
            .filter((point) => point.requests > 0)
            .map((point) => (
              <circle
                cx={point.x}
                cy={point.y}
                fill="var(--card)"
                key={point.bucketStart}
                r="4"
                stroke="var(--chart-1)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              >
                <title>
                  {formatUtc(point.bucketStart)}: {point.requests} requests
                </title>
              </circle>
            ))}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <time dateTime={first.bucketStart}>{shortUtc(first.bucketStart)}</time>
        <span>Requests per minute · UTC</span>
        <time dateTime={last.bucketStart}>{shortUtc(last.bucketStart)}</time>
      </div>
    </div>
  );
}

function shortUtc(value: string) {
  return `${new Date(value).toISOString().slice(11, 16)} UTC`;
}
