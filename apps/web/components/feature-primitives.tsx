import { Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

export function formatLatency(value: number | null | undefined) {
  return value === null || value === undefined ? 'No data' : `${value} ms`;
}

export function formatUtc(value: string) {
  return `${new Date(value).toLocaleString(undefined, { timeZone: 'UTC' })} UTC`;
}

export function humanizeAction(value: string) {
  return value
    .split('.')
    .map((part) => part.replaceAll('_', ' '))
    .join(' · ');
}

export function Metric({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  const displayValue =
    typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-4 text-2xl font-semibold tabular-nums">
        {displayValue}
      </div>
    </div>
  );
}

export function Panel({
  children,
  detail,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  detail: string;
  icon: typeof Search;
  title: string;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex gap-3 border-b border-border p-5">
        <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
        <div>
          <h2 className="font-medium">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export function State({ value }: { value: string }) {
  const variant = ['READY', 'SUCCEEDED', 'ACTIVE'].includes(value)
    ? 'success'
    : ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'CREATING'].includes(value)
      ? 'warning'
      : ['FAILED', 'PARTIAL_FAILED', 'REVOKED', 'ERROR'].includes(value)
        ? 'danger'
        : 'neutral';
  return <Badge variant={variant}>{value}</Badge>;
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="rounded-xl border border-border bg-card p-10 text-center">
      <Search
        aria-hidden="true"
        className="mx-auto size-7 text-muted-foreground"
      />
      <h2 className="mt-4 font-medium">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
    </section>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <section
      aria-busy="true"
      aria-label={label}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
      role="status"
    >
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-3/5" />
      <div className="grid gap-3 pt-2 sm:grid-cols-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    </section>
  );
}

export function ErrorState({
  detail,
  onRetry,
  title = 'Could not load this view',
}: {
  detail: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <section
      className="rounded-xl border border-destructive/40 bg-destructive/10 p-8 text-center"
      role="alert"
    >
      <h2 className="font-medium">{title}</h2>
      <p className="mt-2 text-sm text-destructive">{detail}</p>
      {onRetry ? (
        <Button
          className="mt-4"
          onClick={onRetry}
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      ) : null}
    </section>
  );
}
