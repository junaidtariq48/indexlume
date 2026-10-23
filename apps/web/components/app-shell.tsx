'use client';

import {
  Activity,
  BarChart3,
  Building2,
  Check,
  CircleAlert,
  CircleCheck,
  ChevronsUpDown,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FolderKanban,
  Info,
  LayoutDashboard,
  LogOut,
  Menu,
  PlayCircle,
  Plus,
  Search,
  Settings,
  TriangleAlert,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import type { NotificationType, ToastNotification } from './console-events';
import type { Project, User, View, Workspace } from './console-model';
import { viewConfig, viewOrder } from './console-navigation';
import { ThemeToggle } from './theme-provider';
import { Button } from './ui/button';
import { DialogFrame } from './ui/dialog';
import { Input } from './ui/input';

type Health = 'checking' | 'ready' | 'error';

const viewIcons = {
  Overview: LayoutDashboard,
  Sources: Database,
  Indexes: Search,
  'Search Studio': PlayCircle,
  Runs: Activity,
  Analytics: BarChart3,
  Settings,
} satisfies Record<View, typeof Search>;

const toastAppearances = {
  success: {
    icon: CircleCheck,
    container: 'border-success/40 bg-success/10',
    iconColor: 'text-success',
  },
  error: {
    icon: CircleAlert,
    container: 'border-destructive/40 bg-destructive/10',
    iconColor: 'text-destructive',
  },
  warning: {
    icon: TriangleAlert,
    container: 'border-warning/50 bg-warning/10',
    iconColor: 'text-warning',
  },
  info: {
    icon: Info,
    container: 'border-primary/40 bg-primary/10',
    iconColor: 'text-primary',
  },
} satisfies Record<
  NotificationType,
  { icon: typeof CircleCheck; container: string; iconColor: string }
>;

interface AppShellProps {
  canManage: boolean;
  children: ReactNode;
  error: string;
  health: Health;
  onCreateProject: () => void;
  onDismissToast: () => void;
  onLogout: () => void;
  onProjectChange: (projectId: string) => void;
  onViewChange: (view: View) => void;
  onWorkspaceChange: (workspaceId: string) => void | Promise<void>;
  project?: Project;
  projectId: string;
  projects: Project[];
  toast: ToastNotification | null;
  user: User | null;
  view: View;
  workspace?: Workspace;
  workspaceId: string;
  workspaces: Workspace[];
}

export function AppShell({
  canManage,
  children,
  error,
  health,
  onCreateProject,
  onDismissToast,
  onLogout,
  onProjectChange,
  onViewChange,
  onWorkspaceChange,
  project,
  projectId,
  projects,
  toast,
  user,
  view,
  workspace,
  workspaceId,
  workspaces,
}: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeQuery, setScopeQuery] = useState('');
  const [scopeBusy, setScopeBusy] = useState(false);
  const mobileDialog = useRef<HTMLDialogElement>(null);
  const commandDialog = useRef<HTMLDialogElement>(null);
  const current = viewConfig[view];
  const toastAppearance = toast
    ? toastAppearances[toast.type]
    : toastAppearances.info;
  const ToastIcon = toastAppearance.icon;

  useEffect(() => {
    const dialog = mobileDialog.current;
    if (!dialog) return;
    if (mobileOpen && !dialog.open) dialog.showModal();
    if (!mobileOpen && dialog.open) dialog.close();
  }, [mobileOpen]);

  useEffect(() => {
    const dialog = commandDialog.current;
    if (!dialog) return;
    if (commandOpen && !dialog.open) dialog.showModal();
    if (!commandOpen && dialog.open) dialog.close();
  }, [commandOpen]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.matches('input, textarea, select, [contenteditable="true"]') ??
        false;
      if (
        !editing &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        setCommandQuery('');
        setCommandOpen(true);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  function selectView(next: View) {
    onViewChange(next);
    setMobileOpen(false);
    setCommandOpen(false);
  }

  const commandItems = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    return viewOrder.filter((item) => {
      const config = viewConfig[item];
      return (
        !query ||
        `${config.label} ${config.description}`.toLowerCase().includes(query)
      );
    });
  }, [commandQuery]);

  const filteredWorkspaces = useMemo(() => {
    const query = scopeQuery.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        (item.id === workspaceId &&
          projects.some((projectItem) =>
            `${projectItem.name} ${projectItem.slug}`
              .toLowerCase()
              .includes(query),
          )),
    );
  }, [projects, scopeQuery, workspaceId, workspaces]);

  async function selectWorkspace(id: string) {
    if (id === workspaceId) return;
    setScopeBusy(true);
    try {
      await onWorkspaceChange(id);
    } finally {
      setScopeBusy(false);
    }
  }

  function selectProject(id: string) {
    onProjectChange(id);
    setScopeOpen(false);
    setMobileOpen(false);
  }

  function openScopePicker(fromMobile = false) {
    setScopeQuery('');
    if (fromMobile) {
      setMobileOpen(false);
      window.requestAnimationFrame(() => setScopeOpen(true));
    } else {
      setScopeOpen(true);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        className="fixed left-3 top-3 z-[70] -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-transform focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-background lg:flex',
          collapsed ? 'w-20 p-3' : 'w-64 p-4',
        )}
      >
        <SidebarContent
          collapsed={collapsed}
          onClose={undefined}
          onLogout={onLogout}
          onOpenScope={() => openScopePicker()}
          onViewChange={selectView}
          project={project}
          user={user}
          view={view}
          workspace={workspace}
        />
        <Button
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="mt-3 w-full"
          onClick={() => setCollapsed((value) => !value)}
          size={collapsed ? 'icon' : 'sm'}
          type="button"
          variant="ghost"
        >
          {collapsed ? (
            <ChevronsRight className="size-4" />
          ) : (
            <>
              <ChevronsLeft className="size-4" />
              Collapse sidebar
            </>
          )}
        </Button>
      </aside>

      <dialog
        aria-label="Navigation"
        aria-modal="true"
        className="m-0 h-dvh w-[min(20rem,88vw)] max-h-none max-w-none border-0 border-r border-border bg-background p-4 text-foreground shadow-2xl"
        onCancel={(event) => {
          event.preventDefault();
          setMobileOpen(false);
        }}
        onClose={() => setMobileOpen(false)}
        ref={mobileDialog}
        role="dialog"
      >
        {mobileOpen ? (
          <SidebarContent
            collapsed={false}
            onClose={() => setMobileOpen(false)}
            onLogout={onLogout}
            onOpenScope={() => openScopePicker(true)}
            onViewChange={selectView}
            project={project}
            user={user}
            view={view}
            workspace={workspace}
          />
        ) : null}
      </dialog>

      <div className={cn(collapsed ? 'lg:pl-20' : 'lg:pl-64')}>
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-3 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              aria-label="Open navigation"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Menu className="size-5" />
            </Button>
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 text-sm"
            >
              <span className="hidden truncate text-muted-foreground sm:inline">
                {workspace?.name ?? 'Workspace'}
              </span>
              <span
                aria-hidden="true"
                className="hidden text-muted-foreground sm:inline"
              >
                /
              </span>
              <span className="truncate text-muted-foreground">
                {project?.name ?? 'No project'}
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                /
              </span>
              <span className="truncate font-medium">{current.label}</span>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <button
              className="hidden h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground md:flex"
              onClick={() => {
                setCommandQuery('');
                setCommandOpen(true);
              }}
              type="button"
            >
              <Search className="size-3.5" />
              Navigate
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px]">
                Ctrl K
              </kbd>
            </button>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  'size-2 rounded-full',
                  health === 'ready'
                    ? 'bg-success'
                    : health === 'error'
                      ? 'bg-destructive'
                      : 'bg-warning',
                )}
              />
              <span className="hidden sm:inline">
                {health === 'ready'
                  ? 'Connected'
                  : health === 'error'
                    ? 'API unavailable'
                    : 'Checking API'}
              </span>
            </span>
            <ThemeToggle />
          </div>
        </header>

        <main
          className="mx-auto max-w-7xl space-y-6 p-4 sm:p-8"
          id="main-content"
          tabIndex={-1}
        >
          <div className="border-b border-border pb-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              {current.group}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {current.label}
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              {current.description}
            </p>
          </div>
          {error ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {children}
        </main>
        <footer className="mx-auto max-w-7xl border-t border-border px-4 py-5 text-xs leading-5 text-muted-foreground sm:px-8">
          © 2026 Oryxsol · Indexlume original code is licensed under Apache-2.0.
          Third-party components retain their own licenses.
        </footer>
      </div>

      <DialogFrame
        description="Choose a workspace, then select the project you want to manage."
        onOpenChange={(open) => {
          if (!scopeBusy) setScopeOpen(open);
        }}
        open={scopeOpen}
        size="lg"
        title="Select workspace and project"
      >
        <div className="mt-5">
          <label className="sr-only" htmlFor="scope-search">
            Search workspaces and projects
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              className="pl-9"
              id="scope-search"
              onChange={(event) => setScopeQuery(event.target.value)}
              placeholder="Search workspaces and projects…"
              value={scopeQuery}
            />
          </div>
        </div>

        <div className="mt-4 max-h-[min(32rem,60vh)] space-y-3 overflow-y-auto pr-1">
          {filteredWorkspaces.map((item) => {
            const activeWorkspace = item.id === workspaceId;
            const visibleProjects = activeWorkspace
              ? projects.filter((projectItem) => {
                  const query = scopeQuery.trim().toLowerCase();
                  return (
                    !query ||
                    item.name.toLowerCase().includes(query) ||
                    `${projectItem.name} ${projectItem.slug}`
                      .toLowerCase()
                      .includes(query)
                  );
                })
              : [];
            return (
              <section
                className="overflow-hidden rounded-lg border border-border"
                key={item.id}
              >
                <button
                  aria-current={activeWorkspace ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent',
                    activeWorkspace && 'bg-muted',
                  )}
                  disabled={scopeBusy}
                  onClick={() => void selectWorkspace(item.id)}
                  type="button"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
                    <Building2 className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {item.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Workspace · {item.role}
                    </span>
                  </span>
                  {activeWorkspace ? (
                    <Check className="size-4 text-primary" />
                  ) : null}
                </button>

                {activeWorkspace ? (
                  <div className="border-t border-border bg-background p-2">
                    {scopeBusy ? (
                      <p
                        aria-live="polite"
                        className="px-3 py-4 text-sm text-muted-foreground"
                      >
                        Loading projects…
                      </p>
                    ) : visibleProjects.length ? (
                      visibleProjects.map((projectItem) => (
                        <button
                          aria-current={
                            projectItem.id === projectId ? 'true' : undefined
                          }
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-accent',
                            projectItem.id === projectId &&
                              'bg-accent text-accent-foreground',
                          )}
                          key={projectItem.id}
                          onClick={() => selectProject(projectItem.id)}
                          type="button"
                        >
                          <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {projectItem.name}
                            </span>
                            <span className="block truncate font-mono text-xs text-muted-foreground">
                              {projectItem.slug}
                            </span>
                          </span>
                          {projectItem.id === projectId ? (
                            <Check className="size-4 text-primary" />
                          ) : null}
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                        {projects.length
                          ? 'No projects match your search.'
                          : 'No projects in this workspace.'}
                      </p>
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
          {!filteredWorkspaces.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No workspaces or projects match your search.
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Projects keep sources, collections, keys, and activity isolated.
          </p>
          {canManage ? (
            <Button
              disabled={!workspaceId || scopeBusy}
              onClick={() => {
                setScopeOpen(false);
                onCreateProject();
              }}
              type="button"
            >
              <Plus className="size-4" /> Create project
            </Button>
          ) : null}
        </div>
      </DialogFrame>

      <dialog
        aria-label="Navigate"
        aria-modal="true"
        className="m-auto w-[calc(100%-2rem)] max-w-xl rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-2xl"
        onCancel={(event) => {
          event.preventDefault();
          setCommandOpen(false);
        }}
        onClose={() => setCommandOpen(false)}
        ref={commandDialog}
        role="dialog"
      >
        <div className="border-b border-border p-3">
          <label className="sr-only" htmlFor="command-search">
            Search destinations
          </label>
          <div className="flex items-center gap-2">
            <Search
              aria-hidden="true"
              className="ml-2 size-4 text-muted-foreground"
            />
            <Input
              autoFocus
              className="border-0 bg-transparent shadow-none focus-visible:ring-0"
              id="command-search"
              onChange={(event) => setCommandQuery(event.target.value)}
              placeholder="Go to a page…"
              value={commandQuery}
            />
            <Button
              aria-label="Close navigation search"
              onClick={() => setCommandOpen(false)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <div className="max-h-[min(28rem,60vh)] overflow-y-auto p-2">
          {commandItems.map((item) => {
            const Icon = viewIcons[item];
            const config = viewConfig[item];
            return (
              <button
                className={cn(
                  'flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent',
                  item === view && 'bg-muted',
                )}
                key={item}
                onClick={() => selectView(item)}
                type="button"
              >
                <Icon className="mt-0.5 size-4 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">
                    {config.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {config.description}
                  </span>
                </span>
              </button>
            );
          })}
          {!commandItems.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No matching destination.
            </p>
          ) : null}
        </div>
      </dialog>

      {toast ? (
        <div
          aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
          className={cn(
            'fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm text-foreground shadow-xl',
            toastAppearance.container,
          )}
          role={toast.type === 'error' ? 'alert' : 'status'}
        >
          <span className="flex min-w-0 flex-1 items-start gap-2">
            <ToastIcon
              aria-hidden="true"
              className={cn(
                'mt-0.5 size-4 shrink-0',
                toastAppearance.iconColor,
              )}
            />
            <span>{toast.message}</span>
          </span>
          <button
            aria-label="Dismiss notification"
            className="-mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onDismissToast}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface SidebarContentProps {
  collapsed: boolean;
  onClose: (() => void) | undefined;
  onLogout: () => void;
  onOpenScope: () => void;
  onViewChange: (view: View) => void;
  project?: Project;
  user: User | null;
  view: View;
  workspace?: Workspace;
}

function SidebarContent({
  collapsed,
  onClose,
  onLogout,
  onOpenScope,
  onViewChange,
  project,
  user,
  view,
  workspace,
}: SidebarContentProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'flex h-12 items-center',
          collapsed ? 'justify-center' : 'justify-between px-2',
        )}
      >
        <div className="flex min-w-0 items-center">
          <Image
            alt="Indexlume"
            className={cn(
              'shrink-0 object-cover object-center',
              collapsed ? 'size-10' : 'h-10 w-40',
            )}
            height={2000}
            priority
            src="/brand/indexlume-logo.svg"
            unoptimized
            width={2000}
          />
        </div>
        {onClose ? (
          <Button
            aria-label="Close navigation"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-5" />
          </Button>
        ) : null}
      </div>

      <div className="mt-5 border-y border-border py-4">
        <button
          aria-label={`Switch workspace or project. Current workspace: ${workspace?.name ?? 'none'}. Current project: ${project?.name ?? 'none'}`}
          className={cn(
            'flex w-full items-center rounded-lg border border-border bg-card text-left hover:bg-accent',
            collapsed ? 'justify-center p-2' : 'gap-3 p-3',
          )}
          onClick={onOpenScope}
          title={collapsed ? 'Switch workspace or project' : undefined}
          type="button"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
            <FolderKanban className="size-4" />
          </span>
          {!collapsed ? (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {workspace?.name ?? 'No workspace'}
                </span>
                <span className="mt-0.5 block truncate text-sm font-medium">
                  {project?.name ?? 'Select a project'}
                </span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          ) : null}
        </button>
      </div>

      <nav
        aria-label="Primary"
        className="mt-4 flex-1 space-y-5 overflow-y-auto"
      >
        {(['Workspace', 'Project'] as const).map((group) => (
          <div key={group}>
            {!collapsed ? (
              <p className="mb-1 px-3 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {group}
              </p>
            ) : null}
            <div className="space-y-1">
              {viewOrder
                .filter((item) => viewConfig[item].group === group)
                .map((item) => {
                  const Icon = viewIcons[item];
                  const config = viewConfig[item];
                  return (
                    <button
                      aria-current={item === view ? 'page' : undefined}
                      aria-label={collapsed ? config.label : undefined}
                      className={cn(
                        'flex w-full items-center rounded-lg py-2 text-left text-sm transition-colors',
                        collapsed ? 'justify-center px-2' : 'gap-3 px-3',
                        item === view
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                      key={item}
                      onClick={() => onViewChange(item)}
                      title={collapsed ? config.label : undefined}
                      type="button"
                    >
                      <Icon className="size-4 shrink-0" />
                      {!collapsed ? config.label : null}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border pt-4">
        {!collapsed ? (
          <div className="truncate px-2 text-sm text-foreground">
            {user?.email}
          </div>
        ) : null}
        <button
          aria-label={collapsed ? 'Sign out' : undefined}
          className={cn(
            'mt-2 flex w-full items-center rounded-lg py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
            collapsed ? 'justify-center px-2' : 'gap-3 px-2',
          )}
          onClick={onLogout}
          title={collapsed ? 'Sign out' : undefined}
          type="button"
        >
          <LogOut className="size-4" />
          {!collapsed ? 'Sign out' : null}
        </button>
      </div>
    </div>
  );
}
