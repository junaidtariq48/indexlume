import type { Project, View, Workspace } from './console-model';

export const viewOrder: View[] = [
  'Overview',
  'Sources',
  'Indexes',
  'Search Studio',
  'Runs',
  'Analytics',
  'Settings',
];

export const viewConfig: Record<
  View,
  {
    description: string;
    group: 'Workspace' | 'Project';
    label: string;
    slug: string;
  }
> = {
  Overview: {
    description:
      'Workspace access and live health for the selected search project.',
    group: 'Workspace',
    label: 'Overview',
    slug: 'overview',
  },
  Sources: {
    description:
      'Connect files and PostgreSQL datasets, then manage synchronization.',
    group: 'Project',
    label: 'Data Sources',
    slug: 'sources',
  },
  Indexes: {
    description:
      'Manage stable search collections and their versioned generations.',
    group: 'Project',
    label: 'Collections',
    slug: 'collections',
  },
  'Search Studio': {
    description:
      'Build validated queries, inspect results, and manage reusable presets.',
    group: 'Project',
    label: 'Search Studio',
    slug: 'search',
  },
  Runs: {
    description:
      'Monitor durable indexing work, inspect failures, and recover safely.',
    group: 'Project',
    label: 'Indexing Jobs',
    slug: 'jobs',
  },
  Analytics: {
    description:
      'Review real request, latency, source, and indexing health metrics.',
    group: 'Project',
    label: 'Analytics',
    slug: 'analytics',
  },
  Settings: {
    description:
      'Configure connections, public search access, and inspect activity.',
    group: 'Project',
    label: 'Settings',
    slug: 'settings',
  },
};

export function viewFromSlug(value: string | null | undefined): View {
  return (
    viewOrder.find((view) => viewConfig[view].slug === value) ?? 'Overview'
  );
}

export function consoleUrl(
  workspace: Workspace | undefined,
  project: Project | undefined,
  view: View,
): string {
  if (!workspace) return '/';
  const params = new URLSearchParams({
    workspace: workspace.slug,
    view: viewConfig[view].slug,
  });
  if (project) params.set('project', project.slug);
  return `/?${params.toString()}`;
}
