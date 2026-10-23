export type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';
export type AssignableRole = Exclude<Role, 'OWNER'>;

export const memberRoleOptions: Array<{
  value: AssignableRole;
  label: string;
  description: string;
}> = [
  {
    value: 'ADMIN',
    label: 'Admin',
    description:
      'Manage members, connections, API keys, projects, and project content.',
  },
  {
    value: 'EDITOR',
    label: 'Editor',
    description:
      'Create and operate data sources, collections, indexing jobs, and search presets.',
  },
  {
    value: 'VIEWER',
    label: 'Viewer',
    description: 'View workspace and project content without making changes.',
  },
];

export type View =
  | 'Overview'
  | 'Sources'
  | 'Indexes'
  | 'Search Studio'
  | 'Runs'
  | 'Analytics'
  | 'Settings';

export interface User {
  id: string;
  email: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface Project {
  id: string;
  publicId: string;
  workspaceId: string;
  name: string;
  slug: string;
  typesenseConnectionId?: string | null;
}

export interface SearchApiKey {
  id: string;
  label: string;
  keyPrefix: string;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  rateLimitOverride?: number | null;
  createdAt: string;
}

export interface Member {
  id: string;
  role: Role;
  user: User & { status: string };
}

export interface Connection {
  id: string;
  name: string;
  mode: 'BUNDLED' | 'EXTERNAL';
  endpoint: string;
  tlsPolicy: string;
}

export interface IndexField {
  name: string;
  type: string;
  searchable: boolean;
  facet: boolean;
  sort: boolean;
  optional: boolean;
}

export interface SearchIndex {
  id: string;
  name: string;
  slug: string;
  alias: string;
  state: 'CREATING' | 'READY' | 'ERROR';
  activeGeneration?: number | null;
  mapping: { fields: IndexField[] };
  searchDefaults: { queryBy: string[] };
  generations: Array<{ recordCount: number }>;
}

export interface SearchResult {
  found: number;
  hits: Array<{ document?: Record<string, unknown> }>;
  requestMs: number;
}

export interface SearchSettings {
  q: string;
  queryBy: string[];
  filterBy?: Array<{
    field: string;
    operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
    value: string | number | boolean;
  }>;
  facetBy?: string[];
  sortBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  page: number;
  perPage: number;
}

export interface SearchPreset {
  id: string;
  name: string;
  settings: SearchSettings;
  createdBy: User;
  updatedAt: string;
}

export interface AnalyticsResponse {
  range: { from: string; to: string; interval: 'minute' | 'hour' | 'day' };
  hasData: boolean;
  summary: {
    requests: number;
    errors: number;
    errorRate: number | null;
    averageMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  series: Array<{
    bucketStart: string;
    requests: number;
    errors: number;
    p50Ms: number | null;
    p95Ms: number | null;
  }>;
  operations: {
    indexCount: number;
    indexedDocuments: number;
    sourceCount: number;
    sourceErrors: number;
    unhealthySources: number;
    activeRuns: number;
    failedRuns: number;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastError: string | null;
  };
  privacy: { queryTermsCollected: false };
}

export interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  createdAt: string;
  actor?: User | null;
}

export interface UploadSource {
  id: string;
  name: string;
  format: 'CSV' | 'JSONL';
  originalName: string;
  rowCount: number;
  sizeBytes: number;
  schema: Array<{ name: string; type: string }>;
  preview?: Array<Record<string, unknown>>;
}

export interface IngestionRun {
  id: string;
  status: string;
  scanned: number;
  succeeded: number;
  failed: number;
  errorSummary?: string | null;
  trigger: string;
  deleted: number;
  generation?: { generation: number } | null;
  source: { name: string; rowCount?: number | null };
  _count: { errors: number };
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostgresColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface PostgresDataset {
  schemaName: string;
  tableName: string;
  kind: string;
  columns: PostgresColumn[];
  primaryKey: string[];
  uniqueKeys: string[][];
  foreignKeys: Array<{
    columns: string[];
    referencedSchema: string;
    referencedTable: string;
    referencedColumns: string[];
  }>;
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
}

export interface ProjectionRelation {
  id: string;
  kind: 'many_to_one' | 'one_to_many' | 'one_to_one';
  from: { relation: 'root' | string; columns: string[] };
  to: { schema: string; table: string; columns: string[] };
  required: boolean;
  limitPerRoot?: number;
  predicates: never[];
  changeTracking:
    | { mode: 'reconcile_only' }
    | {
        mode: 'poll';
        updatedAt: string;
        key: string[];
        overlapSeconds: number;
      };
}

export interface ProjectionField {
  path: string;
  targetField: string;
  op:
    | 'identity'
    | 'string'
    | 'int64'
    | 'float'
    | 'bool'
    | 'sum'
    | 'count'
    | 'min'
    | 'max'
    | 'unique_sorted_array';
  maxItems?: number;
}

export interface ProjectionConfig {
  version: 1;
  root: {
    schema: string;
    table: string;
    pk: string[];
    idPrefix: string;
    changeTracking: ProjectionRelation['changeTracking'];
  };
  relations: ProjectionRelation[];
  fields: ProjectionField[];
  limits: {
    maxTables: number;
    maxFields: number;
    maxRelationDepth: number;
    maxRowsPerRoot: number;
    maxDocumentBytes: number;
    batchRoots: number;
    queryTimeoutMs: number;
  };
  sync: {
    strategy: 'poll_and_reconcile';
    pollSeconds: number;
    reconcileHours: number;
  };
}

export interface SourceProjection {
  id: string;
  projectId: string;
  sourceId: string;
  searchIndexId: string;
  name: string;
  status: string;
  source: { id: string; name: string };
  searchIndex: SearchIndex;
  draftVersion?: {
    id: string;
    status: string;
    config: ProjectionConfig;
    updatedAt: string;
  } | null;
}

export interface ProjectionGeneration {
  id: string;
  status:
    | 'QUEUED'
    | 'RUNNING'
    | 'READY_TO_PROMOTE'
    | 'PROMOTING'
    | 'ACTIVE'
    | 'FAILED'
    | 'CANCELLED'
    | 'SUPERSEDED';
  fencingToken: string;
  counters: { scanned?: number; imported?: number; failed?: number };
  errorCode?: string | null;
  indexGeneration: {
    generation: number;
    physicalCollection: string;
    recordCount: number;
  };
}

export interface ProjectionReconciliation {
  id: string;
  status:
    | 'QUEUED'
    | 'SCANNING'
    | 'COMPLETE'
    | 'AWAITING_CONFIRMATION'
    | 'EXECUTING'
    | 'EXECUTED'
    | 'INVALID';
  complete: boolean;
  expectedCount: number;
  rootCount: number;
  manifestDigest?: string | null;
  candidateSetDigest?: string | null;
  expiresAt?: string | null;
  invalidReason?: string | null;
  confirmationToken?: string;
  candidates?: Array<{
    id: string;
    documentId: string;
    reason: string;
    state: string;
  }>;
}

export interface PostgresSource {
  id: string;
  name: string;
  type: 'POSTGRES';
  state: string;
  lastTestedAt?: string | null;
  lastSyncAt?: string | null;
  errorCount: number;
  lastError?: string | null;
  datasets: Array<{ schemaName: string; tableName: string }>;
  searchIndexes: Array<{
    id: string;
    name: string;
    scheduledSync?: { intervalMinutes: number; nextRunAt: string } | null;
  }>;
}

export interface ListResponse<T> {
  data: T[];
}
