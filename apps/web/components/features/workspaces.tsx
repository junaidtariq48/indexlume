'use client';

import { CheckCircle2, Clock3, LayoutDashboard, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { apiRequest } from '../../lib/api';
import { memberRoleOptions } from '../console-model';
import type {
  AnalyticsResponse,
  AssignableRole,
  IngestionRun,
  ListResponse,
  Member,
  Project,
  SearchIndex,
  Workspace,
  View,
} from '../console-model';
import {
  Empty,
  Metric,
  Panel,
  State,
  formatLatency,
  formatUtc,
} from '../feature-primitives';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { DialogFrame } from '../ui/dialog';
import { Input } from '../ui/input';

export function Overview({
  workspace,
  project,
  projectId,
  indexes,
  onNavigate,
}: {
  workspace?: Workspace;
  project?: Project;
  projectId: string;
  indexes: SearchIndex[];
  onNavigate: (view: View) => void;
}) {
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [analyticsError, setAnalyticsError] = useState('');
  const [recentRuns, setRecentRuns] = useState<IngestionRun[]>([]);
  useEffect(() => {
    setAnalytics(null);
    setAnalyticsError('');
    setRecentRuns([]);
    if (!projectId) return;
    void Promise.allSettled([
      apiRequest<AnalyticsResponse>(`/projects/${projectId}/analytics`),
      Promise.allSettled(
        indexes.map((index) =>
          apiRequest<ListResponse<IngestionRun>>(`/indexes/${index.id}/runs`),
        ),
      ),
    ]).then(([analyticsResult, runsResult]) => {
      if (analyticsResult.status === 'fulfilled') {
        setAnalytics(analyticsResult.value);
      } else {
        setAnalyticsError(
          analyticsResult.reason instanceof Error
            ? analyticsResult.reason.message
            : 'Could not load project status',
        );
      }
      if (runsResult.status === 'fulfilled') {
        setRecentRuns(
          runsResult.value
            .filter(
              (
                response,
              ): response is PromiseFulfilledResult<
                ListResponse<IngestionRun>
              > => response.status === 'fulfilled',
            )
            .flatMap((response) => response.value.data)
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 5),
        );
      }
    });
  }, [indexes, projectId]);
  if (!project) {
    return (
      <Empty
        detail="Use the workspace and project selector in the sidebar to choose a project or create one."
        title="No project selected"
      />
    );
  }
  return (
    <>
      <section>
        <div className="mb-4 flex items-end justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-primary">
              Project overview
            </p>
            <h2 className="mt-1 text-2xl font-semibold">
              {project?.name ?? 'No project selected'}
            </h2>
          </div>
          <span className="rounded-full border border-border px-3 py-1 text-xs">
            {workspace?.name} · {workspace?.role}
          </span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Metric
            label="Indexed documents"
            value={analytics?.operations.indexedDocuments ?? '—'}
          />
          <Metric
            label="Sources"
            value={analytics?.operations.sourceCount ?? '—'}
          />
          <Metric
            label="Active jobs"
            value={analytics?.operations.activeRuns ?? '—'}
          />
          <Metric
            label="Search requests · 7d"
            value={analytics?.summary.requests ?? '—'}
          />
          <Metric
            label="p50 latency"
            value={formatLatency(analytics?.summary.p50Ms)}
          />
          <Metric
            label="p95 latency"
            value={formatLatency(analytics?.summary.p95Ms)}
          />
        </div>
        {analyticsError && (
          <p className="mt-3 text-sm text-destructive">{analyticsError}</p>
        )}
        {analytics?.operations.lastError && (
          <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Latest ingestion error: {analytics.operations.lastError}
          </p>
        )}
      </section>
      <ProjectHealth
        analytics={analytics}
        hasConnection={Boolean(project?.typesenseConnectionId)}
        recentRuns={recentRuns}
        onNavigate={onNavigate}
      />
    </>
  );
}

function ProjectHealth({
  analytics,
  hasConnection,
  recentRuns,
  onNavigate,
}: {
  analytics: AnalyticsResponse | null;
  hasConnection: boolean;
  recentRuns: IngestionRun[];
  onNavigate: (view: View) => void;
}) {
  const health = !hasConnection
    ? 'Needs connection'
    : analytics?.operations.unhealthySources
      ? 'Source attention needed'
      : analytics?.operations.failedRuns
        ? 'Failed jobs need review'
        : 'Healthy';
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel
        detail="Current status derived from connection, source, and job state."
        icon={CheckCircle2}
        title="Project health"
      >
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{health}</span>
            <State value={health === 'Healthy' ? 'READY' : 'ERROR'} />
          </div>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Connection</dt>
              <dd className="mt-1 font-medium">
                {hasConnection ? 'Configured' : 'Not configured'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Source health</dt>
              <dd className="mt-1 font-medium">
                {analytics
                  ? `${analytics.operations.unhealthySources} unhealthy`
                  : 'Loading…'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Last successful job
              </dt>
              <dd className="mt-1 font-medium">
                {analytics?.operations.lastSuccessAt
                  ? formatUtc(analytics.operations.lastSuccessAt)
                  : 'No successful job'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Failed jobs</dt>
              <dd className="mt-1 font-medium">
                {analytics?.operations.failedRuns ?? '—'}
              </dd>
            </div>
          </dl>
        </div>
      </Panel>
      <Panel
        detail="The five newest jobs across this project’s collections."
        icon={Clock3}
        title="Recent jobs"
      >
        <div className="p-5">
          {recentRuns.length ? (
            <div className="divide-y divide-border">
              {recentRuns.map((run) => (
                <div
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  key={run.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {run.source.name}
                    </p>
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={run.createdAt}
                    >
                      {formatUtc(run.createdAt)}
                    </time>
                  </div>
                  <State value={run.status} />
                </div>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No indexing jobs yet.
            </p>
          )}
          <Button
            className="mt-4"
            onClick={() => onNavigate('Runs')}
            size="sm"
            type="button"
            variant="outline"
          >
            View all jobs
          </Button>
        </div>
      </Panel>
    </div>
  );
}

export function EmptyWorkspace({
  onCreated,
}: {
  onCreated: (value: Workspace) => void;
}) {
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8 text-center">
      <LayoutDashboard className="mx-auto size-8 text-primary" />
      <h2 className="mt-5 text-2xl font-semibold">
        Create your first workspace
      </h2>
      <CreateForm
        endpoint="/workspaces"
        button="Create workspace"
        onCreated={onCreated}
      />
    </section>
  );
}
export function CreateProjectDialog({
  onCreated,
  onOpenChange,
  open,
  workspaceId,
}: {
  onCreated: (value: Project) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceId: string;
}) {
  return (
    <DialogFrame
      description="Projects isolate sources, collections, search keys, and activity inside a workspace."
      onOpenChange={onOpenChange}
      open={open}
      title="Create project"
    >
      <CreateForm<Project>
        button="Create project"
        endpoint={`/workspaces/${workspaceId}/projects`}
        onCancel={() => onOpenChange(false)}
        onCreated={onCreated}
      />
    </DialogFrame>
  );
}
export function MemberForm({
  workspaceId,
  onCancel,
  onCreated,
}: {
  workspaceId: string;
  onCancel: () => void;
  onCreated: (value: Member) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AssignableRole>('EDITOR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onCreated(
        await apiRequest<Member>(`/workspaces/${workspaceId}/members`, {
          method: 'POST',
          body: JSON.stringify({ email, password, role }),
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not add member',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mt-5 space-y-4" onSubmit={submit}>
      <label className="block text-sm font-medium">
        Email
        <Input
          autoFocus
          className="mt-2"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </label>
      <label className="block text-sm font-medium">
        Temporary password
        <Input
          className="mt-2"
          minLength={12}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        <span className="mt-1 block text-xs font-normal text-muted-foreground">
          At least 12 characters.
        </span>
      </label>
      <label className="block text-sm font-medium">
        Role
        <Combobox
          ariaLabel="Member role"
          className="mt-2"
          onValueChange={(value) => setRole(value as AssignableRole)}
          options={memberRoleOptions.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
            group: 'Workspace roles',
            keywords: [option.description],
          }))}
          searchPlaceholder="Search roles…"
          value={role}
        />
        <span className="mt-2 block text-xs font-normal leading-5 text-muted-foreground">
          {
            memberRoleOptions.find((option) => option.value === role)
              ?.description
          }
        </span>
      </label>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button
          disabled={busy}
          onClick={onCancel}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button disabled={busy} type="submit">
          {busy ? 'Adding…' : 'Add member'}
        </Button>
      </div>
    </form>
  );
}
function CreateForm<T extends { id: string }>({
  endpoint,
  button,
  onCancel,
  onCreated,
}: {
  endpoint: string;
  button: string;
  onCancel?: () => void;
  onCreated: (value: T) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const value = await apiRequest<T>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ name, slug }),
      });
      onCreated(value);
      setName('');
      setSlug('');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : `Could not ${button.toLowerCase()}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-5 space-y-4">
      <label className="block text-sm font-medium">
        Name
        <Input
          autoFocus
          className="mt-2"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSlug(
              event.target.value
                .toLowerCase()
                .trim()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, ''),
            );
          }}
        />
      </label>
      <label className="block text-sm font-medium">
        Slug
        <Input
          className="mt-2 font-mono"
          required
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
      </label>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        {onCancel ? (
          <Button
            disabled={busy}
            onClick={onCancel}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
        ) : null}
        <Button disabled={busy} type="submit">
          <Plus className="size-4" /> {busy ? 'Creating…' : button}
        </Button>
      </div>
    </form>
  );
}
