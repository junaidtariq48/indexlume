'use client';

import {
  Activity,
  CircleAlert,
  Copy,
  Database,
  KeyRound,
  type LucideIcon,
  Plus,
  Settings,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { apiRequest } from '../../lib/api';
import { cn } from '../../lib/utils';
import { notify } from '../console-events';
import type {
  AssignableRole,
  AuditEntry,
  Connection,
  ListResponse,
  Member,
  Project,
  SearchApiKey,
} from '../console-model';
import { memberRoleOptions } from '../console-model';
import { State, formatUtc, humanizeAction } from '../feature-primitives';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { ConfirmDialog, DialogFrame } from '../ui/dialog';
import { Input } from '../ui/input';
import { MemberForm } from './workspaces';

const settingsTabs = [
  ['project', 'Project'],
  ['connections', 'Connections'],
  ['members', 'Members'],
  ['api', 'API keys'],
  ['activity', 'Activity'],
] as const;

function SettingsPanel({
  children,
  detail,
  icon: Icon,
  title,
}: {
  children: ReactNode;
  detail: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-start gap-4 border-b border-border px-6 py-5 max-sm:px-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-base font-semibold leading-5">{title}</h2>
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
            {detail}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

function auditDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(value));
}

function titleCase(value: string) {
  const normalized = value.replaceAll('_', ' ').toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function actionVariant(action: string) {
  const verb = action.split('.').at(-1)?.toLowerCase();
  if (verb === 'created') return 'success' as const;
  if (['updated', 'tested'].includes(verb ?? '')) return 'info' as const;
  if (['deleted', 'revoked', 'failed'].includes(verb ?? ''))
    return 'danger' as const;
  return 'neutral' as const;
}

export function SettingsView({
  workspaceId,
  project,
  connections,
  canManage,
  members,
  onConnection,
  onMember,
  onProject,
}: {
  workspaceId: string;
  project?: Project;
  connections: Connection[];
  canManage: boolean;
  members: Member[];
  onConnection: (value: Connection) => void;
  onMember: (value: Member) => void;
  onProject: (value: Project) => void;
}) {
  const [tab, setTab] = useState<
    'project' | 'connections' | 'members' | 'api' | 'activity'
  >('project');
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const [mode, setMode] = useState<'BUNDLED' | 'EXTERNAL'>('BUNDLED');
  const [name, setName] = useState('Bundled Typesense');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pageError, setPageError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [keyError, setKeyError] = useState('');
  const [searchKeys, setSearchKeys] = useState<SearchApiKey[]>([]);
  const [keyLabel, setKeyLabel] = useState('Website search');
  const [revealedKey, setRevealedKey] = useState('');
  const [keysLoading, setKeysLoading] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | undefined>();
  const [auditLoading, setAuditLoading] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<SearchApiKey | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState('');
  const [pendingConnectionId, setPendingConnectionId] = useState('');
  useEffect(() => setRevealedKey(''), [project?.id]);
  useEffect(
    () => setPendingConnectionId(project?.typesenseConnectionId ?? ''),
    [project?.id, project?.typesenseConnectionId],
  );
  const loadSearchKeys = useCallback(async () => {
    if (!project) return setSearchKeys([]);
    setKeysLoading(true);
    try {
      const response = await apiRequest<ListResponse<SearchApiKey>>(
        `/projects/${project.id}/search-keys`,
      );
      setSearchKeys(response.data);
    } catch (caught) {
      setPageError(
        caught instanceof Error ? caught.message : 'Could not load search keys',
      );
    } finally {
      setKeysLoading(false);
    }
  }, [project]);
  useEffect(() => {
    if (tab === 'api') void loadSearchKeys();
  }, [loadSearchKeys, tab]);
  const loadAudit = useCallback(
    async (cursor?: string) => {
      if (!project) return setAuditEntries([]);
      setAuditLoading(true);
      try {
        const response = await apiRequest<{
          data: AuditEntry[];
          meta: { nextCursor?: string };
        }>(
          `/projects/${project.id}/audit?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        setAuditEntries((items) =>
          cursor ? [...items, ...response.data] : response.data,
        );
        setAuditCursor(response.meta.nextCursor);
      } catch (caught) {
        setPageError(
          caught instanceof Error ? caught.message : 'Could not load audit log',
        );
      } finally {
        setAuditLoading(false);
      }
    },
    [project],
  );
  useEffect(() => {
    if (tab === 'activity') void loadAudit();
  }, [loadAudit, tab]);
  const auditGroups = useMemo(() => {
    const groups = new Map<string, AuditEntry[]>();
    for (const entry of auditEntries) {
      const label = auditDate(entry.createdAt);
      groups.set(label, [...(groups.get(label) ?? []), entry]);
    }
    return [...groups.entries()];
  }, [auditEntries]);
  async function create(event: FormEvent) {
    event.preventDefault();
    setConnectionError('');
    setMutationBusy('connection-create');
    try {
      const body =
        mode === 'BUNDLED'
          ? { name, mode }
          : { name, mode, endpoint, apiKey, tlsPolicy: 'STRICT' };
      const created = await apiRequest<Connection>(
        `/workspaces/${workspaceId}/typesense-connections`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      onConnection(created);
      setApiKey('');
      setConnectionOpen(false);
      notify('Connection created and verified.');
    } catch (caught) {
      setConnectionError(
        caught instanceof Error
          ? caught.message
          : 'Could not create connection',
      );
    } finally {
      setMutationBusy('');
    }
  }
  async function test(item: Connection) {
    setMutationBusy(`connection-test:${item.id}`);
    setPageError('');
    try {
      await apiRequest(`/typesense-connections/${item.id}/test`, {
        method: 'POST',
      });
      notify(`${item.name} is healthy.`);
    } catch (caught) {
      setPageError(
        caught instanceof Error ? caught.message : 'Connection test failed',
      );
    } finally {
      setMutationBusy('');
    }
  }
  async function map(id: string) {
    if (!project || !id) return;
    setMutationBusy('project-map');
    setPageError('');
    try {
      onProject(
        await apiRequest<Project>(`/projects/${project.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ typesenseConnectionId: id }),
        }),
      );
      notify('Project connection updated.');
    } catch (caught) {
      setPageError(
        caught instanceof Error
          ? caught.message
          : 'Could not update the project connection',
      );
    } finally {
      setMutationBusy('');
    }
  }
  async function updateMemberRole(item: Member, role: AssignableRole) {
    if (item.role === role) return;
    setMutationBusy(`member-role:${item.id}`);
    setPageError('');
    try {
      const updated = await apiRequest<Member>(
        `/workspaces/${workspaceId}/members/${item.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        },
      );
      onMember(updated);
      notify(`${item.user.email} is now ${titleCase(role)}.`);
    } catch (caught) {
      setPageError(
        caught instanceof Error
          ? caught.message
          : 'Could not update the member role',
      );
    } finally {
      setMutationBusy('');
    }
  }
  async function createSearchKey(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    setKeyError('');
    setMutationBusy('key-create');
    try {
      const created = await apiRequest<SearchApiKey & { secret: string }>(
        `/projects/${project.id}/search-keys`,
        {
          method: 'POST',
          body: JSON.stringify({ label: keyLabel }),
        },
      );
      setSearchKeys((items) => [created, ...items]);
      setRevealedKey(created.secret);
      setKeyLabel('Website search');
      setKeyOpen(false);
      notify(
        'Search key created. Copy it now; it will not be shown again.',
        'warning',
      );
      await loadAudit();
    } catch (caught) {
      setKeyError(
        caught instanceof Error
          ? caught.message
          : 'Could not create search key',
      );
    } finally {
      setMutationBusy('');
    }
  }
  async function revokeSearchKey(item: SearchApiKey) {
    setRevokeBusy(true);
    setPageError('');
    try {
      await apiRequest(`/search-keys/${item.id}/revoke`, { method: 'POST' });
      setRevokeTarget(null);
      setRevealedKey('');
      await loadSearchKeys();
      await loadAudit();
      notify(`${item.label} was revoked.`);
    } catch (caught) {
      setRevokeTarget(null);
      setPageError(
        caught instanceof Error
          ? caught.message
          : 'Could not revoke search key',
      );
    } finally {
      setRevokeBusy(false);
    }
  }

  async function copyRevealedKey() {
    try {
      await navigator.clipboard.writeText(revealedKey);
      notify('Search key copied.');
    } catch {
      setPageError(
        'Could not copy the search key. Select and copy it manually.',
      );
    }
  }
  async function copyText(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(message);
    } catch {
      notify(
        'Could not copy this value. Select and copy it manually.',
        'error',
      );
    }
  }
  return (
    <>
      <div className="space-y-6">
        <div
          aria-label="Settings sections"
          className="flex gap-1 overflow-x-auto border-b border-border px-1"
          role="tablist"
        >
          {settingsTabs.map(([value, label], index) => (
            <button
              aria-controls={`settings-panel-${value}`}
              aria-selected={tab === value}
              className={cn(
                'relative -mb-px px-4 py-4 text-sm font-semibold whitespace-nowrap transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-t-full after:transition-colors',
                tab === value
                  ? 'text-primary after:bg-primary'
                  : 'text-muted-foreground after:bg-transparent hover:text-foreground',
              )}
              key={value}
              onClick={() => {
                setPageError('');
                setTab(value);
              }}
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const nextIndex =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? settingsTabs.length - 1
                      : (index +
                          (event.key === 'ArrowRight' ? 1 : -1) +
                          settingsTabs.length) %
                        settingsTabs.length;
                const next = settingsTabs[nextIndex]?.[0] ?? 'project';
                setPageError('');
                setTab(next);
                document.getElementById(`settings-tab-${next}`)?.focus();
              }}
              role="tab"
              id={`settings-tab-${value}`}
              tabIndex={tab === value ? 0 : -1}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        {pageError ? (
          <div
            className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            <span>{pageError}</span>
          </div>
        ) : null}

        {tab === 'connections' ? (
          <div
            aria-labelledby="settings-tab-connections"
            className="space-y-5"
            id="settings-panel-connections"
            role="tabpanel"
          >
            <SettingsPanel
              detail="Workspace scope · Administrative keys stay encrypted and are only used by the API."
              icon={Database}
              title="Typesense connections"
            >
              <div className="p-6 max-sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <p className="text-sm text-muted-foreground sm:text-base">
                    {connections.length
                      ? `${connections.length} ${connections.length === 1 ? 'connection' : 'connections'}`
                      : 'No connections configured'}
                  </p>
                  {canManage ? (
                    <Button
                      className="h-11 px-5"
                      onClick={() => setConnectionOpen(true)}
                      type="button"
                    >
                      <Plus className="size-4" /> Add connection
                    </Button>
                  ) : null}
                </div>
                {connections.length ? (
                  <div className="mt-5 divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {connections.map((item) => (
                      <div
                        className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
                        key={item.id}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-base font-semibold">
                              {item.name}
                            </span>
                            <Badge
                              variant={
                                item.mode === 'BUNDLED' ? 'info' : 'warning'
                              }
                            >
                              {titleCase(item.mode)}
                            </Badge>
                            {item.id === project?.typesenseConnectionId ? (
                              <Badge variant="success">
                                Active in this project
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 truncate font-mono text-sm text-muted-foreground">
                            {item.endpoint}
                          </div>
                        </div>
                        {canManage ? (
                          <Button
                            disabled={Boolean(mutationBusy)}
                            className="h-10 px-4"
                            onClick={() => void test(item)}
                            type="button"
                            variant="outline"
                          >
                            {mutationBusy === `connection-test:${item.id}`
                              ? 'Testing…'
                              : 'Test'}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    Add a bundled or external Typesense connection to continue.
                  </p>
                )}
              </div>
            </SettingsPanel>
          </div>
        ) : null}

        {tab === 'project' ? (
          <div
            aria-labelledby="settings-tab-project"
            className="space-y-5"
            id="settings-panel-project"
            role="tabpanel"
          >
            <SettingsPanel
              detail="Project scope · Choose which validated workspace connection this project uses."
              icon={Settings}
              title="Project settings"
            >
              <div className="p-6 max-sm:p-4">
                {project ? (
                  <div className="max-w-3xl">
                    <label
                      className="block text-base font-semibold"
                      htmlFor="active-typesense-connection"
                    >
                      Active Typesense connection
                    </label>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Search Studio, collections and indexing jobs in this
                      project use this connection.
                    </p>
                    <Combobox
                      ariaLabel="Active Typesense connection"
                      className="mt-3 h-12 text-base"
                      disabled={
                        !canManage ||
                        !connections.length ||
                        Boolean(mutationBusy)
                      }
                      id="active-typesense-connection"
                      onValueChange={setPendingConnectionId}
                      options={[
                        { value: '', label: 'Not connected' },
                        ...connections.map((item) => ({
                          value: item.id,
                          label: item.name,
                          group:
                            item.mode === 'BUNDLED' ? 'Bundled' : 'External',
                          keywords: [item.endpoint],
                        })),
                      ]}
                      searchPlaceholder="Search connections…"
                      value={pendingConnectionId}
                    />
                    {!connections.length ? (
                      <span className="mt-2 block text-xs font-normal text-muted-foreground">
                        Add a workspace connection before mapping this project.
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Select a project first.
                  </p>
                )}
              </div>
              {project && canManage ? (
                <div className="flex justify-end border-t border-border bg-muted/30 px-6 py-4 max-sm:px-4">
                  <Button
                    className="h-10 px-4"
                    disabled={
                      Boolean(mutationBusy) ||
                      pendingConnectionId ===
                        (project.typesenseConnectionId ?? '')
                    }
                    onClick={() => void map(pendingConnectionId)}
                    type="button"
                    variant="outline"
                  >
                    {mutationBusy === 'project-map'
                      ? 'Saving…'
                      : 'Save changes'}
                  </Button>
                </div>
              ) : null}
            </SettingsPanel>
          </div>
        ) : null}

        {tab === 'members' ? (
          <div
            aria-labelledby="settings-tab-members"
            className="space-y-5"
            id="settings-panel-members"
            role="tabpanel"
          >
            <SettingsPanel
              detail="Workspace scope · Owner, admin, editor, and viewer permissions are enforced by the API."
              icon={Users}
              title="Workspace members"
            >
              <div className="p-6 max-sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <p className="text-sm text-muted-foreground sm:text-base">
                    {members.length}{' '}
                    {members.length === 1 ? 'member' : 'members'}
                  </p>
                  {canManage ? (
                    <Button
                      className="h-11 px-5"
                      onClick={() => setMemberOpen(true)}
                      type="button"
                    >
                      <Plus className="size-4" /> Add member
                    </Button>
                  ) : null}
                </div>
                <div className="mt-5 divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {members.map((item) => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm"
                      key={item.id}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                          {item.role.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="truncate text-base">
                          {item.user.email}
                        </span>
                      </span>
                      {canManage && item.role !== 'OWNER' ? (
                        <Combobox
                          ariaLabel={`Role for ${item.user.email}`}
                          className="w-36"
                          contentClassName="w-96 max-w-[calc(100vw-2rem)]"
                          disabled={Boolean(mutationBusy)}
                          onValueChange={(value) =>
                            void updateMemberRole(item, value as AssignableRole)
                          }
                          options={memberRoleOptions.map((option) => ({
                            value: option.value,
                            label: option.label,
                            description: option.description,
                            group: 'Workspace roles',
                            keywords: [option.description],
                          }))}
                          searchPlaceholder="Search roles…"
                          value={item.role}
                        />
                      ) : (
                        <Badge
                          variant={item.role === 'OWNER' ? 'info' : 'neutral'}
                        >
                          {titleCase(item.role)}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </SettingsPanel>
          </div>
        ) : null}

        {tab === 'api' ? (
          <div
            aria-labelledby="settings-tab-api"
            className="space-y-5"
            id="settings-panel-api"
            role="tabpanel"
          >
            <SettingsPanel
              detail="Project scope · Read-only credentials are shown once and revocation is immediate."
              icon={KeyRound}
              title="Search API keys"
            >
              <div className="p-6 max-sm:p-4">
                {!project ? (
                  <p className="text-sm text-muted-foreground">
                    Select a project first.
                  </p>
                ) : keysLoading ? (
                  <p className="text-sm text-muted-foreground">
                    Loading search keys…
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <p className="text-sm text-muted-foreground sm:text-base">
                        {searchKeys.length
                          ? `${searchKeys.length} ${searchKeys.length === 1 ? 'key' : 'keys'}`
                          : 'No search keys yet'}
                      </p>
                      {canManage ? (
                        <Button
                          className="h-11 px-5"
                          onClick={() => setKeyOpen(true)}
                          type="button"
                        >
                          <Plus className="size-4" /> Create key
                        </Button>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        'mt-5 overflow-hidden rounded-lg border border-border',
                        searchKeys.length
                          ? 'divide-y divide-border'
                          : 'border-dashed',
                      )}
                    >
                      {searchKeys.length ? (
                        searchKeys.map((item) => (
                          <div
                            className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"
                            key={item.id}
                          >
                            <div>
                              <div className="text-base font-semibold">
                                {item.label}{' '}
                                <State
                                  value={item.revokedAt ? 'REVOKED' : 'ACTIVE'}
                                />
                              </div>
                              <div className="mt-1 font-mono text-xs text-muted-foreground">
                                {item.keyPrefix}… ·{' '}
                                {item.lastUsedAt ? 'Used' : 'Never used'}
                              </div>
                            </div>
                            {canManage && !item.revokedAt ? (
                              <Button
                                onClick={() => setRevokeTarget(item)}
                                size="sm"
                                type="button"
                                variant="outline"
                              >
                                Revoke
                              </Button>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <div className="px-5 py-10 text-center">
                          <p className="font-semibold">No keys created</p>
                          <p className="mt-2 text-sm text-muted-foreground">
                            Create a read-only key when a search client is ready
                            to integrate.
                          </p>
                        </div>
                      )}
                    </div>
                    {revealedKey ? (
                      <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-4">
                        <p className="text-sm font-medium text-warning-foreground dark:text-warning">
                          Copy this key now. It cannot be retrieved later.
                        </p>
                        <div className="mt-2 flex gap-2">
                          <code className="min-w-0 flex-1 overflow-x-auto rounded bg-background p-2 text-xs text-warning-foreground dark:text-warning">
                            {revealedKey}
                          </code>
                          <Button
                            aria-label="Copy search key"
                            onClick={() => void copyRevealedKey()}
                            size="icon"
                            type="button"
                            variant="outline"
                          >
                            <Copy className="size-4" />
                          </Button>
                        </div>
                        <button
                          className="mt-3 text-xs text-muted-foreground underline"
                          onClick={() => setRevealedKey('')}
                          type="button"
                        >
                          I have saved it securely
                        </button>
                      </div>
                    ) : null}
                    <div className="mt-6">
                      <h3 className="text-base font-semibold">Use a key</h3>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="mt-5 text-sm text-muted-foreground">
                          <span className="block">Public project ID</span>
                          <code className="block font-mono text-sm text-foreground">
                            {project.publicId}
                          </code>
                        </span>
                        <Button
                          onClick={() =>
                            void copyText(
                              project.publicId,
                              'Project ID copied.',
                            )
                          }
                          className="mt-5 h-10 px-4"
                          type="button"
                          variant="outline"
                        >
                          Copy ID
                        </Button>
                      </div>
                      <div className="mt-3 overflow-hidden rounded-lg bg-slate-950 text-slate-100">
                        <div className="flex items-center justify-between px-5 py-3 text-xs text-slate-300">
                          <span className="font-semibold">
                            Example search request
                          </span>
                          <span className="font-semibold uppercase">POST</span>
                        </div>
                        <pre className="overflow-x-auto whitespace-pre-wrap px-5 pb-5 font-mono text-xs leading-6">{`POST /api/v1/search/v1/${project.publicId}/<index-slug>\nAuthorization: Bearer ${revealedKey || '<search-key>'}\n\n{"q":"keyboard","page":1,"perPage":10}`}</pre>
                      </div>
                      <Button
                        className="mt-3 h-10 px-4"
                        onClick={() =>
                          void copyText(
                            `POST /api/v1/search/v1/${project.publicId}/<index-slug>\nAuthorization: Bearer ${revealedKey || '<search-key>'}\n\n{"q":"keyboard","page":1,"perPage":10}`,
                            'Example request copied.',
                          )
                        }
                        type="button"
                        variant="outline"
                      >
                        Copy request
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </SettingsPanel>
          </div>
        ) : null}

        {tab === 'activity' ? (
          <div
            aria-labelledby="settings-tab-activity"
            className="space-y-5"
            id="settings-panel-activity"
            role="tabpanel"
          >
            <SettingsPanel
              detail="Project scope · Recent changes with actor and UTC timestamp. Entries are append-only."
              icon={Activity}
              title="Audit trail"
            >
              {!project ? (
                <div className="p-6 max-sm:p-4">
                  <p className="text-sm text-muted-foreground">
                    Select a project first.
                  </p>
                </div>
              ) : auditEntries.length ? (
                <div>
                  {auditGroups.map(([date, entries]) => (
                    <section key={date}>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-6 py-3 text-sm font-semibold max-sm:px-4">
                        <h3>{date}</h3>
                        <span className="text-muted-foreground">
                          {entries.length}{' '}
                          {entries.length === 1 ? 'entry' : 'entries'}, newest
                          first
                        </span>
                      </div>
                      <div className="divide-y divide-border">
                        {entries.map((entry) => {
                          const variant = actionVariant(entry.action);
                          const verb = titleCase(
                            entry.action.split('.').at(-1) ?? 'activity',
                          );
                          return (
                            <div
                              className="grid gap-3 px-6 py-5 text-sm max-sm:px-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
                              key={entry.id}
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'size-2.5 rounded-full',
                                  variant === 'success'
                                    ? 'bg-success'
                                    : variant === 'danger'
                                      ? 'bg-destructive'
                                      : 'bg-primary',
                                )}
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-foreground">
                                    {humanizeAction(entry.action)}
                                  </span>
                                  <Badge variant={variant}>{verb}</Badge>
                                </div>
                                <div className="mt-1 font-mono text-xs text-muted-foreground">
                                  {entry.targetType
                                    .replaceAll('_', ' ')
                                    .toLowerCase()}
                                  {entry.targetId
                                    ? ` · ${entry.targetId.slice(0, 8)}`
                                    : ''}
                                </div>
                              </div>
                              <div className="text-sm text-muted-foreground sm:text-right">
                                <div className="font-medium text-foreground">
                                  {entry.actor?.email ?? 'System'}
                                </div>
                                <time
                                  className="mt-0.5 block"
                                  dateTime={entry.createdAt}
                                  title={entry.createdAt}
                                >
                                  {formatUtc(entry.createdAt)}
                                </time>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                  {auditCursor ? (
                    <div className="border-t border-border px-6 py-4 max-sm:px-4">
                      <Button
                        disabled={auditLoading}
                        onClick={() => void loadAudit(auditCursor)}
                        type="button"
                        variant="outline"
                      >
                        {auditLoading ? 'Loading…' : 'Load more'}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="px-6 py-10 text-center text-sm text-muted-foreground max-sm:px-4">
                  {auditLoading
                    ? 'Loading audit trail…'
                    : 'No project activity recorded yet.'}
                </p>
              )}
            </SettingsPanel>
          </div>
        ) : null}
      </div>

      <DialogFrame
        description="Create an account and choose the access it needs in this workspace."
        onOpenChange={setMemberOpen}
        open={memberOpen}
        title="Add workspace member"
      >
        <MemberForm
          workspaceId={workspaceId}
          onCancel={() => setMemberOpen(false)}
          onCreated={(created) => {
            onMember(created);
            setMemberOpen(false);
            notify(
              `${created.user.email} was added as ${titleCase(created.role)}.`,
            );
          }}
        />
      </DialogFrame>

      <DialogFrame
        description="Administrative credentials are encrypted and never returned after creation."
        onOpenChange={(open) => {
          setConnectionOpen(open);
          if (open) setConnectionError('');
        }}
        open={connectionOpen}
        title="Add Typesense connection"
      >
        <form className="mt-5 space-y-4" onSubmit={create}>
          <label className="block text-sm font-medium">
            Connection type
            <Combobox
              ariaLabel="Connection type"
              className="mt-2"
              onValueChange={(value) =>
                setMode(value as 'BUNDLED' | 'EXTERNAL')
              }
              options={[
                {
                  value: 'BUNDLED',
                  label: 'Bundled',
                  group: 'Connection types',
                },
                {
                  value: 'EXTERNAL',
                  label: 'External',
                  group: 'Connection types',
                },
              ]}
              value={mode}
            />
          </label>
          <label className="block text-sm font-medium">
            Name
            <Input
              autoFocus
              className="mt-2"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          {mode === 'EXTERNAL' ? (
            <>
              <label className="block text-sm font-medium">
                Endpoint
                <Input
                  className="mt-2"
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="https://typesense.example"
                  required
                  type="url"
                  value={endpoint}
                />
              </label>
              <label className="block text-sm font-medium">
                Admin API key
                <Input
                  autoComplete="new-password"
                  className="mt-2"
                  onChange={(event) => setApiKey(event.target.value)}
                  required
                  type="password"
                  value={apiKey}
                />
              </label>
            </>
          ) : null}
          {connectionError ? (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{connectionError}</span>
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              onClick={() => setConnectionOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={mutationBusy === 'connection-create'}
              type="submit"
            >
              {mutationBusy === 'connection-create'
                ? 'Creating…'
                : 'Create connection'}
            </Button>
          </div>
        </form>
      </DialogFrame>

      <DialogFrame
        description="The key is read-only, scoped to this project, and its secret is shown once."
        onOpenChange={(open) => {
          setKeyOpen(open);
          if (open) setKeyError('');
        }}
        open={keyOpen}
        title="Create search API key"
      >
        <form className="mt-5 space-y-4" onSubmit={createSearchKey}>
          <label className="block text-sm font-medium">
            Key label
            <Input
              autoFocus
              className="mt-2"
              maxLength={100}
              onChange={(event) => setKeyLabel(event.target.value)}
              required
              value={keyLabel}
            />
          </label>
          {keyError ? (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>{keyError}</span>
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              onClick={() => setKeyOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={mutationBusy === 'key-create'} type="submit">
              {mutationBusy === 'key-create' ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </form>
      </DialogFrame>

      <ConfirmDialog
        busy={revokeBusy}
        confirmLabel="Revoke key"
        description={
          revokeTarget
            ? `Revoke “${revokeTarget.label}”? Existing clients using this key will stop working immediately.`
            : ''
        }
        onConfirm={() =>
          revokeTarget ? revokeSearchKey(revokeTarget) : undefined
        }
        onOpenChange={(open) => {
          if (!open && !revokeBusy) setRevokeTarget(null);
        }}
        open={Boolean(revokeTarget)}
        title="Revoke search key?"
        variant="destructive"
      />
    </>
  );
}
