'use client';

import {
  AlertTriangle,
  Copy,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiRequest } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { IngestionRun, ListResponse, SearchIndex } from '../console-model';
import { Empty, formatUtc } from '../feature-primitives';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { ConfirmDialog } from '../ui/dialog';

type RunError = {
  id: string;
  sourceKey: string;
  code: string;
  sanitizedMessage: string;
};

const runFilters = [
  { label: 'All', value: 'all' },
  { label: 'Running', value: 'running' },
  { label: 'Needs attention', value: 'attention' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'Succeeded', value: 'succeeded' },
] as const;

type RunFilter = (typeof runFilters)[number]['value'];

export function RunsView({
  indexes,
  canManage,
}: {
  indexes: SearchIndex[];
  canManage: boolean;
}) {
  const [indexId, setIndexId] = useState('');
  const [runs, setRuns] = useState<IngestionRun[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState<RunFilter>('all');
  const [errors, setErrors] = useState<RunError[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<{
    run: IngestionRun;
    operation: 'cancel' | 'retry-failed';
  } | null>(null);
  const selectedIndex = indexId || indexes[0]?.id || '';
  const filteredRuns = useMemo(
    () => runs.filter((run) => matchesFilter(run.status, filter)),
    [filter, runs],
  );
  const selectedRun =
    filteredRuns.find((run) => run.id === selectedId) ??
    filteredRuns[0] ??
    null;

  const load = useCallback(async () => {
    if (!selectedIndex) return setRuns([]);
    setLoading(true);
    try {
      const response = await apiRequest<ListResponse<IngestionRun>>(
        `/indexes/${selectedIndex}/runs`,
      );
      setRuns(response.data);
      setMessage('');
    } catch (caught) {
      setMessage(
        caught instanceof Error ? caught.message : 'Could not load jobs',
      );
    } finally {
      setLoading(false);
    }
  }, [selectedIndex]);

  useEffect(() => {
    setSelectedId('');
    setErrors([]);
    void load();
  }, [load]);

  const hasActiveRun = useMemo(
    () =>
      runs.some((run) =>
        ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(run.status),
      ),
    [runs],
  );
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, load]);

  useEffect(() => {
    setErrors([]);
    if (!selectedRun?._count.errors) return;
    setErrorsLoading(true);
    void apiRequest<ListResponse<RunError>>(`/runs/${selectedRun.id}/errors`)
      .then((response) => setErrors(response.data))
      .catch((caught: unknown) =>
        setMessage(
          caught instanceof Error ? caught.message : 'Could not load errors',
        ),
      )
      .finally(() => setErrorsLoading(false));
  }, [selectedRun?.id, selectedRun?._count.errors]);

  async function runAction() {
    if (!pending) return;
    try {
      await apiRequest(`/runs/${pending.run.id}/${pending.operation}`, {
        method: 'POST',
      });
      setMessage(
        pending.operation === 'cancel'
          ? 'Cancellation requested.'
          : 'Retry queued.',
      );
      setPending(null);
      await load();
    } catch (caught) {
      setMessage(
        caught instanceof Error ? caught.message : 'Could not update the job',
      );
    }
  }

  async function copyJobId(run: IngestionRun) {
    try {
      await navigator.clipboard.writeText(run.id);
      setMessage('Job ID copied.');
    } catch {
      setMessage('Could not copy the job ID.');
    }
  }

  if (!indexes.length)
    return (
      <Empty
        title="No collections"
        detail="Create a collection before viewing indexing jobs."
      />
    );

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-2 xl:gap-3">
            <Combobox
              ariaLabel="Collection"
              className="w-40 shrink-0 xl:w-48"
              contentClassName="w-72"
              emptyMessage="No collections found."
              onValueChange={setIndexId}
              options={indexes.map((item) => ({
                value: item.id,
                label: item.name,
                group: 'Collections',
              }))}
              placeholder="Select collection"
              searchPlaceholder="Search collections…"
              value={selectedIndex}
            />
            <div
              aria-label="Filter indexing jobs"
              className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 xl:gap-2"
              role="group"
            >
              {runFilters.map((item) => (
                <button
                  aria-pressed={filter === item.value}
                  className={cn(
                    'h-10 shrink-0 rounded-full border px-3 text-sm font-medium transition-colors xl:px-4',
                    filter === item.value
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                  key={item.value}
                  onClick={() => {
                    setFilter(item.value);
                    setSelectedId('');
                  }}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <Button
            className="self-start xl:self-auto"
            disabled={loading}
            onClick={() => void load()}
            type="button"
            variant="outline"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        {message ? (
          <p
            className="rounded-lg border border-border bg-card p-3 text-sm"
            role="status"
          >
            {message}
          </p>
        ) : null}

        {filteredRuns.length ? (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.06fr)_minmax(21rem,0.94fr)]">
            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
                <h2 className="font-semibold">Job history</h2>
                <p className="text-sm text-muted-foreground">
                  {filteredRuns.length}{' '}
                  {filteredRuns.length === 1 ? 'job' : 'jobs'}, newest first
                </p>
              </div>
              <div className="divide-y divide-border">
                {filteredRuns.map((run) => (
                  <RunRow
                    active={run.id === selectedRun?.id}
                    key={run.id}
                    onSelect={() => setSelectedId(run.id)}
                    run={run}
                  />
                ))}
              </div>
            </section>
            {selectedRun ? (
              <RunDetail
                canManage={canManage}
                errors={errors}
                errorsLoading={errorsLoading}
                onAction={(operation) =>
                  setPending({ run: selectedRun, operation })
                }
                onCopy={() => void copyJobId(selectedRun)}
                run={selectedRun}
              />
            ) : null}
          </div>
        ) : (
          <Empty
            title={loading ? 'Loading jobs' : `No ${filterLabel(filter)} jobs`}
            detail={
              loading
                ? 'Reading durable ingestion progress…'
                : filter === 'all'
                  ? 'Build or synchronize this collection to create its first job.'
                  : 'Choose another filter to inspect this collection’s job history.'
            }
          />
        )}
      </div>

      <ConfirmDialog
        confirmLabel={
          pending?.operation === 'cancel'
            ? 'Request cancellation'
            : 'Queue retry'
        }
        description={
          pending?.operation === 'cancel'
            ? 'The worker will stop safely at its next cancellation checkpoint.'
            : 'A new job will be queued from the failed job’s existing source and checkpoint.'
        }
        onConfirm={runAction}
        onOpenChange={(open) => !open && setPending(null)}
        open={Boolean(pending)}
        title={
          pending?.operation === 'cancel'
            ? 'Cancel this job?'
            : 'Retry this job?'
        }
        variant={pending?.operation === 'cancel' ? 'destructive' : 'default'}
      />
    </>
  );
}

function RunRow({
  active,
  onSelect,
  run,
}: {
  active: boolean;
  onSelect: () => void;
  run: IngestionRun;
}) {
  const total = run.source.rowCount ?? run.scanned;
  const percent = total
    ? Math.min(100, Math.round((run.scanned / total) * 100))
    : 0;
  return (
    <button
      aria-current={active ? 'true' : undefined}
      className={cn(
        'relative block w-full px-5 py-4 text-left transition-colors hover:bg-muted/50',
        active &&
          'bg-accent/70 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-primary',
      )}
      onClick={onSelect}
      type="button"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'mt-2 size-2.5 shrink-0 rounded-full',
            statusDot(run.status),
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-semibold">
                {run.generation
                  ? `Generation ${run.generation.generation}`
                  : humanizeTrigger(run.trigger)}
              </span>
              <RunState value={run.status} />
            </div>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {run.scanned.toLocaleString()} / {total.toLocaleString()}
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {run.source.name} · {formatUtc(run.createdAt)}
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', progressColor(run.status))}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </div>
    </button>
  );
}

function RunDetail({
  canManage,
  errors,
  errorsLoading,
  onAction,
  onCopy,
  run,
}: {
  canManage: boolean;
  errors: RunError[];
  errorsLoading: boolean;
  onAction: (operation: 'cancel' | 'retry-failed') => void;
  onCopy: () => void;
  run: IngestionRun;
}) {
  const total = run.source.rowCount ?? run.scanned;
  const percent = total
    ? Math.min(100, Math.round((run.scanned / total) * 100))
    : 0;
  const notice = runNotice(run);

  return (
    <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold tracking-tight">
          {run.generation
            ? `Generation ${run.generation.generation}`
            : humanizeTrigger(run.trigger)}
        </h2>
        <RunState value={run.status} />
      </div>
      <p className="mt-1 font-mono text-sm text-muted-foreground">
        Job {run.id.slice(0, 8)}
      </p>

      {notice ? (
        <div
          className={cn(
            'mt-6 rounded-xl px-4 py-4 text-sm leading-6',
            ['FAILED', 'PARTIAL_FAILED'].includes(run.status)
              ? 'bg-destructive/10 text-destructive'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {notice}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {canManage && ['QUEUED', 'RUNNING'].includes(run.status) ? (
          <Button
            onClick={() => onAction('cancel')}
            type="button"
            variant="destructive"
          >
            <XCircle className="size-4" /> Cancel job
          </Button>
        ) : null}
        {canManage &&
        ['FAILED', 'PARTIAL_FAILED', 'CANCELLED'].includes(run.status) ? (
          <Button onClick={() => onAction('retry-failed')} type="button">
            <RotateCcw className="size-4" /> Retry job
          </Button>
        ) : null}
        <Button onClick={onCopy} type="button" variant="outline">
          <Copy className="size-4" /> Copy job ID
        </Button>
      </div>

      <dl className="mt-5 grid grid-cols-2 overflow-hidden rounded-xl border border-border sm:grid-cols-3">
        <MetricCell label="Scanned" value={run.scanned.toLocaleString()} />
        <MetricCell label="Succeeded" value={run.succeeded.toLocaleString()} />
        <MetricCell label="Failed" value={run.failed.toLocaleString()} />
        <MetricCell label="Deleted" value={run.deleted.toLocaleString()} />
        <MetricCell
          label="Recorded errors"
          value={run._count.errors.toLocaleString()}
        />
        <MetricCell label="Progress" value={`${percent}%`} />
      </dl>

      <dl className="mt-5 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[7rem_1fr]">
        <Detail label="Source" value={run.source.name} />
        <Detail label="Trigger" value={humanizeTrigger(run.trigger)} />
        <Detail
          label="Started"
          value={run.startedAt ? formatUtc(run.startedAt) : 'Not started'}
        />
        <Detail
          label="Finished"
          value={run.finishedAt ? formatUtc(run.finishedAt) : 'Not finished'}
        />
      </dl>

      {run._count.errors ? (
        <section className="mt-6 border-t border-border pt-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="size-4 text-destructive" /> Record errors
          </h3>
          {errorsLoading ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading sanitized errors…
            </p>
          ) : (
            <div className="mt-3 max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {errors.map((error) => (
                <div className="p-3 text-xs" key={error.id}>
                  <div className="font-mono text-destructive">
                    {error.sourceKey} · {error.code}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {error.sanitizedMessage}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-r border-border p-4 even:border-r-0 sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0 sm:[&:nth-last-child(-n+3)]:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{value}</dd>
    </>
  );
}

function RunState({ value }: { value: string }) {
  const variant =
    value === 'SUCCEEDED'
      ? 'success'
      : ['FAILED', 'PARTIAL_FAILED'].includes(value)
        ? 'danger'
        : ['RUNNING', 'QUEUED', 'CANCEL_REQUESTED'].includes(value)
          ? 'warning'
          : 'neutral';
  return <Badge variant={variant}>{statusLabel(value)}</Badge>;
}

function matchesFilter(status: string, filter: RunFilter) {
  if (filter === 'all') return true;
  if (filter === 'running')
    return ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(status);
  if (filter === 'attention')
    return ['FAILED', 'PARTIAL_FAILED'].includes(status);
  if (filter === 'cancelled') return status === 'CANCELLED';
  return status === 'SUCCEEDED';
}

function filterLabel(filter: RunFilter) {
  return runFilters.find((item) => item.value === filter)?.label.toLowerCase();
}

function statusLabel(value: string) {
  if (value === 'PARTIAL_FAILED') return 'Partial failure';
  if (value === 'CANCEL_REQUESTED') return 'Cancelling';
  return value.toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function statusDot(status: string) {
  if (status === 'SUCCEEDED') return 'bg-success';
  if (['FAILED', 'PARTIAL_FAILED'].includes(status)) return 'bg-destructive';
  if (['RUNNING', 'QUEUED', 'CANCEL_REQUESTED'].includes(status))
    return 'bg-warning';
  return 'bg-muted-foreground/65';
}

function progressColor(status: string) {
  if (status === 'SUCCEEDED') return 'bg-success';
  if (['FAILED', 'PARTIAL_FAILED'].includes(status)) return 'bg-destructive';
  if (['RUNNING', 'QUEUED', 'CANCEL_REQUESTED'].includes(status))
    return 'bg-primary';
  return 'bg-muted-foreground/30';
}

function runNotice(run: IngestionRun) {
  if (run.errorSummary) return run.errorSummary;
  if (run.status === 'CANCELLED')
    return run.scanned
      ? `Cancelled after ${run.scanned.toLocaleString()} documents were scanned. Completed document changes remain durable.`
      : 'Cancelled before any documents were scanned. Nothing was added to or removed from the index.';
  if (run.status === 'FAILED')
    return 'This job stopped before it could finish. Review the recorded errors before retrying.';
  if (run.status === 'PARTIAL_FAILED')
    return 'Some documents could not be indexed. Review the recorded errors, then retry the failed records.';
  return '';
}

function humanizeTrigger(value: string) {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}
