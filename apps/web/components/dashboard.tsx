'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { apiRequest } from '../lib/api';
import { AppShell } from './app-shell';
import type { ToastNotification } from './console-events';
import type {
  Connection,
  ListResponse,
  Member,
  Project,
  SearchIndex,
  User,
  View,
  Workspace,
} from './console-model';
import { consoleUrl, viewFromSlug } from './console-navigation';
import { AnalyticsView } from './features/analytics';
import { IndexesView } from './features/collections';
import { RunsView } from './features/jobs';
import { SearchStudio } from './features/search-studio';
import { SettingsView } from './features/settings';
import { SourcesView } from './features/sources';
import {
  CreateProjectDialog,
  EmptyWorkspace,
  Overview,
} from './features/workspaces';

export function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [indexes, setIndexes] = useState<SearchIndex[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [view, setView] = useState<View>('Overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [health, setHealth] = useState<'checking' | 'ready' | 'error'>(
    'checking',
  );
  const [toast, setToast] = useState<ToastNotification | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [projectOpen, setProjectOpen] = useState(false);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId),
    [workspaceId, workspaces],
  );
  const project = projects.find((item) => item.id === projectId);
  const canManage = workspace?.role === 'OWNER' || workspace?.role === 'ADMIN';
  const canEdit = canManage || workspace?.role === 'EDITOR';

  const loadIndexes = useCallback(async (id: string) => {
    if (!id) return setIndexes([]);
    setIndexes(
      (await apiRequest<ListResponse<SearchIndex>>(`/projects/${id}/indexes`))
        .data,
    );
  }, []);
  const loadWorkspace = useCallback(
    async (id: string, preferredProjectSlug?: string | null) => {
      const [projectResponse, memberResponse, connectionResponse] =
        await Promise.all([
          apiRequest<ListResponse<Project>>(`/workspaces/${id}/projects`),
          apiRequest<ListResponse<Member>>(`/workspaces/${id}/members`),
          apiRequest<ListResponse<Connection>>(
            `/workspaces/${id}/typesense-connections`,
          ),
        ]);
      setProjects(projectResponse.data);
      setMembers(memberResponse.data);
      setConnections(connectionResponse.data);
      const selected =
        projectResponse.data.find(
          (item) => item.slug === preferredProjectSlug,
        ) ?? projectResponse.data[0];
      setProjectId(selected?.id ?? '');
      return selected;
    },
    [],
  );
  const bootstrap = useCallback(async () => {
    try {
      const [me, response] = await Promise.all([
        apiRequest<{ user: User }>('/auth/me'),
        apiRequest<ListResponse<Workspace>>('/workspaces'),
      ]);
      setUser(me.user);
      setWorkspaces(response.data);
      const params = new URLSearchParams(window.location.search);
      const selectedWorkspace =
        response.data.find((item) => item.slug === params.get('workspace')) ??
        response.data[0];
      setView(viewFromSlug(params.get('view')));
      setWorkspaceId(selectedWorkspace?.id ?? '');
      if (selectedWorkspace) {
        await loadWorkspace(selectedWorkspace.id, params.get('project'));
      }
    } catch {
      router.replace('/login');
    } finally {
      setLoading(false);
    }
  }, [loadWorkspace, router]);
  useEffect(() => void bootstrap(), [bootstrap]);
  useEffect(() => {
    let active = true;
    async function check() {
      try {
        await apiRequest('/health/ready');
        if (active) setHealth('ready');
      } catch {
        if (active) setHealth('error');
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    function show(event: Event) {
      const detail = (event as CustomEvent<ToastNotification | string>).detail;
      const notification =
        typeof detail === 'string'
          ? { message: detail, type: 'success' as const }
          : detail;
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast(notification);
      toastTimer.current = window.setTimeout(() => {
        setToast(null);
        toastTimer.current = undefined;
      }, 4_000);
    }
    window.addEventListener('osc-toast', show);
    return () => {
      window.removeEventListener('osc-toast', show);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);
  function dismissToast() {
    setToast(null);
    if (toastTimer.current) {
      window.clearTimeout(toastTimer.current);
      toastTimer.current = undefined;
    }
  }
  useEffect(() => {
    void loadIndexes(projectId).catch((caught: unknown) =>
      setError(
        caught instanceof Error ? caught.message : 'Could not load indexes',
      ),
    );
  }, [loadIndexes, projectId]);

  useEffect(() => {
    async function syncUrlState() {
      const params = new URLSearchParams(window.location.search);
      setView(viewFromSlug(params.get('view')));
      const nextWorkspace =
        workspaces.find((item) => item.slug === params.get('workspace')) ??
        workspaces[0];
      if (!nextWorkspace) return;
      if (nextWorkspace.id !== workspaceId) {
        setWorkspaceId(nextWorkspace.id);
        await loadWorkspace(nextWorkspace.id, params.get('project'));
        return;
      }
      const nextProject =
        projects.find((item) => item.slug === params.get('project')) ??
        projects[0];
      setProjectId(nextProject?.id ?? '');
    }
    function handlePopState() {
      void syncUrlState();
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [loadWorkspace, projects, workspaceId, workspaces]);

  function updateUrl(
    nextWorkspace: Workspace | undefined,
    nextProject: Project | undefined,
    nextView: View,
  ) {
    window.history.pushState(
      null,
      '',
      consoleUrl(nextWorkspace, nextProject, nextView),
    );
  }

  async function chooseWorkspace(id: string) {
    const previousWorkspaceId = workspaceId;
    setWorkspaceId(id);
    setError('');
    try {
      const nextWorkspace = workspaces.find((item) => item.id === id);
      const nextProject = await loadWorkspace(id);
      updateUrl(nextWorkspace, nextProject, view);
    } catch (caught) {
      setWorkspaceId(previousWorkspaceId);
      setError(
        caught instanceof Error ? caught.message : 'Could not load workspace',
      );
    }
  }
  function chooseProject(id: string) {
    const nextProject = projects.find((item) => item.id === id);
    setProjectId(id);
    updateUrl(workspace, nextProject, view);
  }
  function chooseView(nextView: View) {
    setView(nextView);
    updateUrl(workspace, project, nextView);
  }
  async function logout() {
    await apiRequest('/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }
  if (loading)
    return (
      <main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        Loading console…
      </main>
    );

  let content: ReactNode;
  if (!workspaces.length)
    content = (
      <EmptyWorkspace
        onCreated={(created) => {
          setWorkspaces([created]);
          setWorkspaceId(created.id);
          updateUrl(created, undefined, 'Overview');
        }}
      />
    );
  else if (view === 'Overview')
    content = (
      <Overview
        workspace={workspace}
        project={project}
        projectId={projectId}
        indexes={indexes}
        onNavigate={chooseView}
      />
    );
  else if (view === 'Sources')
    content = (
      <SourcesView
        project={project}
        indexes={indexes}
        canManage={Boolean(canEdit)}
      />
    );
  else if (view === 'Indexes')
    content = (
      <IndexesView
        project={project}
        indexes={indexes}
        canManage={Boolean(canEdit)}
        onChanged={() => loadIndexes(projectId)}
      />
    );
  else if (view === 'Search Studio')
    content = <SearchStudio indexes={indexes} canManage={Boolean(canEdit)} />;
  else if (view === 'Runs')
    content = <RunsView indexes={indexes} canManage={Boolean(canEdit)} />;
  else if (view === 'Analytics') content = <AnalyticsView project={project} />;
  else
    content = (
      <SettingsView
        workspaceId={workspaceId}
        project={project}
        connections={connections}
        canManage={Boolean(canManage)}
        members={members}
        onConnection={(created) =>
          setConnections((items) => [...items, created])
        }
        onMember={(changed) =>
          setMembers((items) =>
            items.some((item) => item.id === changed.id)
              ? items.map((item) => (item.id === changed.id ? changed : item))
              : [...items, changed],
          )
        }
        onProject={(updated) =>
          setProjects((items) =>
            items.map((item) => (item.id === updated.id ? updated : item)),
          )
        }
      />
    );

  return (
    <>
      <AppShell
        canManage={Boolean(canManage)}
        error={error}
        health={health}
        onCreateProject={() => setProjectOpen(true)}
        onDismissToast={dismissToast}
        onLogout={() => void logout()}
        onProjectChange={chooseProject}
        onViewChange={chooseView}
        onWorkspaceChange={chooseWorkspace}
        project={project}
        projectId={projectId}
        projects={projects}
        toast={toast}
        user={user}
        view={view}
        workspace={workspace}
        workspaceId={workspaceId}
        workspaces={workspaces}
      >
        {content}
      </AppShell>
      <CreateProjectDialog
        onCreated={(created) => {
          setProjects((items) => [...items, created]);
          setProjectId(created.id);
          updateUrl(workspace, created, view);
          setProjectOpen(false);
        }}
        onOpenChange={setProjectOpen}
        open={projectOpen}
        workspaceId={workspaceId}
      />
    </>
  );
}
