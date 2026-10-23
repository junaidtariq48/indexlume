'use client';

import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  Database,
  Eye,
  GitBranch,
  LoaderCircle,
  ShieldCheck,
  Table2,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { apiRequest } from '../../lib/api';
import type {
  IndexField,
  ListResponse,
  PostgresDataset,
  ProjectionConfig,
  ProjectionField,
  ProjectionGeneration,
  ProjectionRelation,
  SearchIndex,
  SourceProjection,
} from '../console-model';
import { ErrorState, LoadingState } from '../feature-primitives';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { Input } from '../ui/input';

const STEPS = [
  'Root entity',
  'Relationships',
  'Fields',
  'Preview',
  'Sync policy',
  'Review & build',
];

const STEP_DESCRIPTIONS = [
  'Choose the database entity that represents one search document.',
  'Add related tables whose fields belong in the same document.',
  'Map database columns to the fields in your target collection.',
  'Validate the mapping against live data before anything is published.',
  'Confirm how database changes should reach the search index.',
  'Review the dataset and start its first production build.',
];

export interface RelationshipCandidate {
  key: string;
  label: string;
  relation: ProjectionRelation;
  dataset: PostgresDataset;
}

export function tracking(
  dataset: PostgresDataset,
): ProjectionRelation['changeTracking'] {
  const updatedAt = dataset.columns.find(
    (column) =>
      column.name === 'updated_at' && column.dataType.includes('timestamp'),
  );
  if (updatedAt && dataset.primaryKey.length) {
    return {
      mode: 'poll',
      updatedAt: updatedAt.name,
      key: dataset.primaryKey,
      overlapSeconds: 2,
    };
  }
  return { mode: 'reconcile_only' };
}

function relationId(schema: string, table: string, hint: string) {
  return `${schema}_${table}_${hint}`
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^[^A-Za-z]/, 'r_')
    .slice(0, 64);
}

export function relationshipCandidates(
  root: PostgresDataset | undefined,
  catalog: PostgresDataset[],
): RelationshipCandidate[] {
  if (!root) return [];
  const candidates: RelationshipCandidate[] = [];
  for (const foreignKey of root.foreignKeys) {
    const target = catalog.find(
      (item) =>
        item.schemaName === foreignKey.referencedSchema &&
        item.tableName === foreignKey.referencedTable,
    );
    if (!target) continue;
    const id = relationId(
      target.schemaName,
      target.tableName,
      foreignKey.columns.join('_'),
    );
    candidates.push({
      key: `out:${id}:${foreignKey.columns.join(',')}`,
      label: `${root.tableName} → ${target.tableName}`,
      dataset: target,
      relation: {
        id,
        kind: 'many_to_one',
        from: { relation: 'root', columns: foreignKey.columns },
        to: {
          schema: target.schemaName,
          table: target.tableName,
          columns: foreignKey.referencedColumns,
        },
        required: false,
        predicates: [],
        changeTracking: tracking(target),
      },
    });
  }
  for (const child of catalog) {
    for (const foreignKey of child.foreignKeys) {
      if (
        foreignKey.referencedSchema !== root.schemaName ||
        foreignKey.referencedTable !== root.tableName
      )
        continue;
      const id = relationId(
        child.schemaName,
        child.tableName,
        foreignKey.columns.join('_'),
      );
      candidates.push({
        key: `in:${id}:${foreignKey.columns.join(',')}`,
        label: `${root.tableName} → ${child.tableName}`,
        dataset: child,
        relation: {
          id,
          kind: 'one_to_many',
          from: { relation: 'root', columns: foreignKey.referencedColumns },
          to: {
            schema: child.schemaName,
            table: child.tableName,
            columns: foreignKey.columns,
          },
          required: false,
          limitPerRoot: 100,
          predicates: [],
          changeTracking: tracking(child),
        },
      });
    }
  }
  return candidates;
}

export function operations(
  field: IndexField,
  many: boolean,
): ProjectionField['op'][] {
  if (many) {
    if (field.type.endsWith('[]')) return ['unique_sorted_array'];
    if (['int32', 'int64'].includes(field.type))
      return ['count', 'sum', 'min', 'max'];
    if (field.type === 'float') return ['sum', 'min', 'max'];
  }
  if (field.type === 'string') return ['identity', 'string'];
  if (field.type === 'int64') return ['identity', 'int64'];
  if (field.type === 'float') return ['identity', 'float'];
  if (field.type === 'bool') return ['identity', 'bool'];
  return ['identity'];
}

export function ProjectionWizard({
  projectId,
  sourceId,
}: {
  projectId: string;
  sourceId: string;
}) {
  const [catalog, setCatalog] = useState<PostgresDataset[]>([]);
  const [indexes, setIndexes] = useState<SearchIndex[]>([]);
  const [sourceName, setSourceName] = useState('PostgreSQL');
  const [step, setStep] = useState(0);
  const [rootKey, setRootKey] = useState('');
  const [indexId, setIndexId] = useState('');
  const [name, setName] = useState('');
  const [selectedRelations, setSelectedRelations] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, ProjectionField>>({});
  const [projection, setProjection] = useState<SourceProjection>();
  const [validated, setValidated] = useState(false);
  const [eventualConsistencyAccepted, setEventualConsistencyAccepted] =
    useState(false);
  const [generation, setGeneration] = useState<ProjectionGeneration>();
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [diagnostics, setDiagnostics] = useState<
    Array<{ code: string; message: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!projectId) {
      setError('A project is required to configure a dataset.');
      setLoading(false);
      return;
    }
    Promise.all([
      apiRequest<{
        data: PostgresDataset[];
        meta: { source: { name: string } };
      }>(`/projects/${projectId}/sources/${sourceId}/relations/catalog`),
      apiRequest<ListResponse<SearchIndex>>(`/projects/${projectId}/indexes`),
    ])
      .then(([catalogResponse, indexResponse]) => {
        setCatalog(catalogResponse.data);
        setSourceName(catalogResponse.meta.source.name);
        setIndexes(indexResponse.data);
        setIndexId(indexResponse.data[0]?.id ?? '');
      })
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : 'Could not load source catalog',
        ),
      )
      .finally(() => setLoading(false));
  }, [projectId, sourceId]);

  useEffect(() => {
    if (!projection || !generation) return;
    if (
      !['QUEUED', 'RUNNING', 'READY_TO_PROMOTE', 'PROMOTING'].includes(
        generation.status,
      )
    )
      return;
    const timer = window.setInterval(() => {
      void apiRequest<ListResponse<ProjectionGeneration>>(
        `/projects/${projectId}/projections/${projection.id}/generations`,
      )
        .then((response) => {
          const current = response.data.find(
            (item) => item.id === generation.id,
          );
          if (current) setGeneration(current);
        })
        .catch((caught) =>
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not refresh build progress',
          ),
        );
    }, 1500);
    return () => window.clearInterval(timer);
  }, [generation, projectId, projection]);

  const root = catalog.find(
    (item) => `${item.schemaName}.${item.tableName}` === rootKey,
  );
  const index = indexes.find((item) => item.id === indexId);
  const candidates = useMemo(
    () => relationshipCandidates(root, catalog),
    [root, catalog],
  );
  const chosen = candidates.filter((item) =>
    selectedRelations.includes(item.key),
  );
  const sources = [
    ...(root
      ? [
          {
            id: 'root',
            label: `${root.schemaName}.${root.tableName}`,
            dataset: root,
            many: false,
          },
        ]
      : []),
    ...chosen.map((item) => ({
      id: item.relation.id,
      label: `${item.dataset.schemaName}.${item.dataset.tableName}`,
      dataset: item.dataset,
      many: item.relation.kind === 'one_to_many',
    })),
  ];
  const targetFields =
    index?.mapping.fields.filter((field) => field.name !== 'id') ?? [];
  const allFieldsMapped = targetFields.every((field) => fields[field.name]);

  function selectRoot(value: string) {
    const nextRoot = catalog.find(
      (item) => `${item.schemaName}.${item.tableName}` === value,
    );
    setRootKey(value);
    setName(nextRoot ? `${nextRoot.tableName} dataset` : '');
    setSelectedRelations([]);
    setFields({});
    setProjection(undefined);
    setValidated(false);
    setEventualConsistencyAccepted(false);
    setGeneration(undefined);
    setPreview([]);
  }

  function setFieldPath(target: IndexField, path: string) {
    const sourceIdForPath = path.split('.')[0] ?? 'root';
    const source = sources.find((item) => item.id === sourceIdForPath);
    const op = operations(target, source?.many ?? false)[0] ?? 'identity';
    setFields((current) => ({
      ...current,
      [target.name]: {
        targetField: target.name,
        path,
        op,
        ...(op === 'unique_sorted_array' ? { maxItems: 100 } : {}),
      },
    }));
  }

  function setFieldOperation(target: IndexField, op: ProjectionField['op']) {
    const current = fields[target.name];
    if (!current) return;
    setFields((items) => ({
      ...items,
      [target.name]: {
        ...current,
        op,
        ...(op === 'unique_sorted_array' ? { maxItems: 100 } : {}),
      },
    }));
  }

  function config(): ProjectionConfig {
    if (!root) throw new Error('Choose a root entity');
    return {
      version: 1,
      root: {
        schema: root.schemaName,
        table: root.tableName,
        pk: root.primaryKey,
        idPrefix: `${root.tableName}_`,
        changeTracking: tracking(root),
      },
      relations: chosen.map((item) => item.relation),
      fields: targetFields.map((field) => fields[field.name]!),
      limits: {
        maxTables: 8,
        maxFields: 80,
        maxRelationDepth: 3,
        maxRowsPerRoot: 2500,
        maxDocumentBytes: 262144,
        batchRoots: 100,
        queryTimeoutMs: 5000,
      },
      sync: {
        strategy: 'poll_and_reconcile',
        pollSeconds: 300,
        reconcileHours: 24,
      },
    };
  }

  async function validateAndPreview() {
    if (!index || !root || !allFieldsMapped) return;
    setBusy(true);
    setError('');
    setPreview([]);
    setDiagnostics([]);
    try {
      const created = await apiRequest<SourceProjection>(
        `/projects/${projectId}/projections`,
        {
          method: 'POST',
          body: JSON.stringify({
            sourceId,
            searchIndexId: index.id,
            name,
            config: config(),
          }),
        },
      );
      setProjection(created);
      const versionId = created.draftVersion?.id;
      if (!versionId) throw new Error('Projection draft was not created');
      const validation = await apiRequest<{
        valid: boolean;
        issues: Array<{ code: string; path: string; message: string }>;
      }>(`/projects/${projectId}/projections/${created.id}/validate`, {
        method: 'POST',
        body: JSON.stringify({ versionId }),
      });
      if (!validation.valid) {
        setDiagnostics(validation.issues);
        return;
      }
      const result = await apiRequest<{
        documents: Array<Record<string, unknown>>;
        diagnostics: Array<{ code: string; message: string }>;
      }>(`/projects/${projectId}/projections/${created.id}/preview`, {
        method: 'POST',
        body: JSON.stringify({ versionId, limit: 10 }),
      });
      setPreview(result.documents);
      setDiagnostics(result.diagnostics);
      setValidated(result.diagnostics.length === 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    const versionId = projection?.draftVersion?.id;
    if (!projection || !versionId || !eventualConsistencyAccepted) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<ProjectionGeneration>(
        `/projects/${projectId}/projections/${projection.id}/publish`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            versionId,
            eventualConsistencyAccepted: true,
          }),
        },
      );
      setGeneration(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading relational catalog" />;
  if (error && !catalog.length)
    return (
      <main className="mx-auto max-w-4xl p-6">
        <ErrorState detail={error} title="Setup unavailable" />
      </main>
    );

  const canContinue =
    step === 0
      ? Boolean(root && root.primaryKey.length === 1 && indexId && name.trim())
      : step === 2
        ? allFieldsMapped
        : step === 3
          ? validated
          : step === 4
            ? eventualConsistencyAccepted
            : true;

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
          <Button asChild size="icon" variant="ghost">
            <Link
              aria-label="Back to data sources"
              href={`/?view=sources&project=${projectId}`}
            >
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {sourceName}
            </p>
            <h1 className="text-lg font-semibold">Create relational dataset</h1>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav
          aria-label="Setup progress"
          className="lg:border-r lg:border-border lg:pr-6"
        >
          <ol className="space-y-1">
            {STEPS.map((label, indexValue) => (
              <li key={label}>
                <button
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${step === indexValue ? 'bg-accent font-semibold text-accent-foreground' : 'text-muted-foreground'}`}
                  disabled={indexValue > step}
                  onClick={() => setStep(indexValue)}
                  type="button"
                >
                  <span
                    className={`flex size-6 items-center justify-center rounded-full border text-xs ${indexValue < step ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}
                  >
                    {indexValue < step ? (
                      <Check className="size-3" />
                    ) : (
                      indexValue + 1
                    )}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <div className="mt-6 border-t border-border pt-5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Setup progress</span>
              <span>{Math.round(((step + 1) / STEPS.length) * 100)}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
              />
            </div>
          </div>
        </nav>

        <section>
          <div className="mb-6">
            <p className="text-sm text-muted-foreground">
              Step {step + 1} of {STEPS.length}
            </p>
            <h2 className="mt-1 text-2xl font-semibold">{STEPS[step]}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {STEP_DESCRIPTIONS[step]}
            </p>
          </div>

          {step === 0 ? (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="space-y-6 rounded-xl border border-border bg-card p-6">
                <div>
                  <label className="text-sm font-medium" htmlFor="root-entity">
                    Root table or view
                  </label>
                  <p className="mb-2 mt-1 text-sm text-muted-foreground">
                    One row from this entity becomes one search document.
                  </p>
                  <Combobox
                    ariaLabel="Root table or view"
                    disabled={validated}
                    id="root-entity"
                    onValueChange={selectRoot}
                    options={catalog.map((item) => ({
                      value: `${item.schemaName}.${item.tableName}`,
                      label: `${item.schemaName}.${item.tableName}${item.primaryKey.length !== 1 ? ' — needs a single-column key' : ''}`,
                      group: item.kind === 'VIEW' ? 'Views' : 'Tables',
                      disabled: item.primaryKey.length !== 1,
                      keywords: [item.schemaName, item.tableName],
                    }))}
                    placeholder="Select an entity"
                    searchPlaceholder="Search tables and views…"
                    value={rootKey}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium" htmlFor="target-index">
                    Target index
                  </label>
                  <Combobox
                    ariaLabel="Target index"
                    className="mt-2"
                    disabled={validated}
                    id="target-index"
                    onValueChange={(value) => {
                      setIndexId(value);
                      setFields({});
                    }}
                    options={indexes.map((item) => ({
                      value: item.id,
                      label: item.name,
                      group: 'Collections',
                      keywords: [item.slug],
                    }))}
                    placeholder="Select an index"
                    searchPlaceholder="Search collections…"
                    value={indexId}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium" htmlFor="dataset-name">
                    Dataset name
                  </label>
                  <Input
                    disabled={validated}
                    id="dataset-name"
                    onChange={(event) => setName(event.target.value)}
                    value={name}
                  />
                </div>
                {root ? (
                  <div className="grid gap-3 rounded-lg bg-muted p-4 text-sm sm:grid-cols-3">
                    <span>
                      <span className="block text-xs text-muted-foreground">
                        Primary key
                      </span>
                      {root.primaryKey.join(', ')}
                    </span>
                    <span>
                      <span className="block text-xs text-muted-foreground">
                        Columns
                      </span>
                      {root.columns.length}
                    </span>
                    <span>
                      <span className="block text-xs text-muted-foreground">
                        Change tracking
                      </span>
                      {tracking(root).mode === 'poll'
                        ? 'Incremental + reconcile'
                        : 'Reconcile only'}
                    </span>
                  </div>
                ) : null}
              </div>
              <aside className="rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold">How it works</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Each row from the root entity becomes one structured search
                  document.
                </p>
                <div className="mt-6 flex items-center justify-between gap-3 rounded-lg bg-muted/60 p-4 text-center text-xs">
                  <span className="rounded-md border border-border bg-card px-3 py-2 font-medium">
                    Database row
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  <span className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 font-medium text-primary">
                    Search JSON
                  </span>
                </div>
                <p className="mt-5 text-xs leading-5 text-muted-foreground">
                  Relationships and field mappings are added in the following
                  steps. Nothing is published until the final review.
                </p>
              </aside>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Choose related data to compose into each {root?.tableName}{' '}
                document. Relationships come from PostgreSQL foreign keys.
              </p>
              {!candidates.length ? (
                <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  No direct foreign-key relationships were discovered. You can
                  continue with the root entity only.
                </div>
              ) : (
                candidates.map((candidate) => (
                  <label
                    className="flex cursor-pointer items-start gap-4 rounded-xl border border-border bg-card p-5"
                    key={candidate.key}
                  >
                    <input
                      checked={selectedRelations.includes(candidate.key)}
                      className="mt-1 size-4"
                      disabled={validated}
                      onChange={(event) =>
                        setSelectedRelations((current) =>
                          event.target.checked
                            ? [...current, candidate.key]
                            : current.filter((item) => item !== candidate.key),
                        )
                      }
                      type="checkbox"
                    />
                    <GitBranch className="mt-0.5 size-5 text-muted-foreground" />
                    <span className="flex-1">
                      <span className="block font-medium">
                        {candidate.label}
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {candidate.relation.kind.replaceAll('_', ' ')} ·{' '}
                        {candidate.relation.from.columns.join(', ')} →{' '}
                        {candidate.relation.to.columns.join(', ')}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="grid grid-cols-[minmax(8rem,1fr)_minmax(12rem,1.3fr)_10rem] gap-3 border-b border-border bg-muted px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Index field</span>
                <span>Source column</span>
                <span>Transform</span>
              </div>
              {targetFields.map((target) => {
                const selected = fields[target.name];
                const selectedSource = sources.find(
                  (item) => item.id === selected?.path.split('.')[0],
                );
                return (
                  <div
                    className="grid grid-cols-[minmax(8rem,1fr)_minmax(12rem,1.3fr)_10rem] gap-3 border-b border-border px-4 py-3 last:border-0"
                    key={target.name}
                  >
                    <span className="self-center text-sm font-medium">
                      {target.name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {target.type}
                      </span>
                    </span>
                    <Combobox
                      ariaLabel={`Source for ${target.name}`}
                      disabled={validated}
                      onValueChange={(value) => setFieldPath(target, value)}
                      options={sources.flatMap((source) =>
                        source.dataset.columns.map((column) => ({
                          value: `${source.id}.${column.name}`,
                          label: column.name,
                          group: source.label,
                          keywords: [source.label, column.dataType],
                        })),
                      )}
                      placeholder="Choose a column"
                      searchPlaceholder="Search source columns…"
                      value={selected?.path ?? ''}
                    />
                    <Combobox
                      ariaLabel={`Transform for ${target.name}`}
                      disabled={!selected || validated}
                      onValueChange={(value) =>
                        setFieldOperation(
                          target,
                          value as ProjectionField['op'],
                        )
                      }
                      options={operations(
                        target,
                        selectedSource?.many ?? false,
                      ).map((op) => ({
                        value: op,
                        label: op.replaceAll('_', ' '),
                        group: 'Transforms',
                      }))}
                      value={selected?.op ?? 'identity'}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-border bg-card p-4">
                  <Table2 className="size-5 text-muted-foreground" />
                  <p className="mt-3 text-xs text-muted-foreground">Root</p>
                  <p className="font-medium">
                    {root?.schemaName}.{root?.tableName}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <GitBranch className="size-5 text-muted-foreground" />
                  <p className="mt-3 text-xs text-muted-foreground">
                    Relationships
                  </p>
                  <p className="font-medium">{chosen.length}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <Database className="size-5 text-muted-foreground" />
                  <p className="mt-3 text-xs text-muted-foreground">
                    Mapped fields
                  </p>
                  <p className="font-medium">{targetFields.length}</p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
                <div>
                  <h3 className="font-semibold">
                    Validate with live source data
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Checks schema compatibility, then composes at most 10
                    read-only sample documents.
                  </p>
                </div>
                <Button
                  disabled={busy || Boolean(projection)}
                  onClick={() => void validateAndPreview()}
                  type="button"
                >
                  <Eye className="size-4" />
                  {busy
                    ? 'Validating…'
                    : projection
                      ? 'Draft created'
                      : 'Validate & preview'}
                </Button>
              </div>
              {error ? (
                <p
                  className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              {diagnostics.length ? (
                <div className="rounded-xl border border-warning/40 bg-warning/10 p-5">
                  <h3 className="font-semibold">Diagnostics</h3>
                  <ul className="mt-3 space-y-2 text-sm">
                    {diagnostics.map((item, indexValue) => (
                      <li key={`${item.code}-${indexValue}`}>
                        <span className="font-mono text-xs">{item.code}</span> —{' '}
                        {item.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.length ? (
                <div>
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <Check className="size-4 text-success" />
                    Validation passed · {preview.length} sample documents
                  </div>
                  <pre className="max-h-[32rem] overflow-auto rounded-xl border border-border bg-card p-5 text-xs leading-5">
                    {JSON.stringify(preview, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-5">
              <div className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-start gap-4">
                  <ShieldCheck className="mt-0.5 size-6 text-primary" />
                  <div>
                    <h3 className="font-semibold">Managed synchronization</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      The first build reads the complete relational dataset into
                      a new index generation. The current live index stays in
                      place until that build is complete and verified.
                    </p>
                  </div>
                </div>
                <dl className="mt-6 grid gap-4 border-t border-border pt-5 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Changes</dt>
                    <dd className="mt-1 font-medium">
                      Checked every 5 minutes
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Full check
                    </dt>
                    <dd className="mt-1 font-medium">Every 24 hours</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Go live</dt>
                    <dd className="mt-1 font-medium">Atomic alias switch</dd>
                  </div>
                </dl>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-5">
                <input
                  checked={eventualConsistencyAccepted}
                  className="mt-1 size-4"
                  onChange={(event) =>
                    setEventualConsistencyAccepted(event.target.checked)
                  }
                  type="checkbox"
                />
                <span>
                  <span className="block font-medium">
                    I understand updates are eventually consistent
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    A database change may take up to the configured polling
                    interval to appear in search.
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          {step === 5 ? (
            <div className="space-y-5">
              <div className="rounded-xl border border-border bg-card p-6">
                <h3 className="font-semibold">Dataset summary</h3>
                <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Dataset</dt>
                    <dd className="mt-1 font-medium">{name}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Root entity</dt>
                    <dd className="mt-1 font-medium">
                      {root?.schemaName}.{root?.tableName}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Relationships</dt>
                    <dd className="mt-1 font-medium">{chosen.length}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Index fields</dt>
                    <dd className="mt-1 font-medium">{targetFields.length}</dd>
                  </div>
                </dl>
              </div>

              {!generation ? (
                <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
                  <div>
                    <h3 className="font-semibold">Ready to build</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Search remains available on the current index during this
                      build.
                    </p>
                  </div>
                  <Button disabled={busy} onClick={() => void publish()}>
                    {busy ? 'Starting…' : 'Build & publish'}
                  </Button>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center gap-3">
                    {[
                      'QUEUED',
                      'RUNNING',
                      'READY_TO_PROMOTE',
                      'PROMOTING',
                    ].includes(generation.status) ? (
                      <LoaderCircle className="size-5 animate-spin text-primary" />
                    ) : generation.status === 'ACTIVE' ? (
                      <Check className="size-5 text-success" />
                    ) : (
                      <span className="size-5 rounded-full bg-destructive" />
                    )}
                    <div>
                      <h3 className="font-semibold">
                        {generation.status === 'ACTIVE'
                          ? 'Dataset is live'
                          : generation.status === 'FAILED'
                            ? 'Build did not complete'
                            : 'Building dataset'}
                      </h3>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {generation.status.replaceAll('_', ' ').toLowerCase()}
                      </p>
                    </div>
                  </div>
                  <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Scanned</dt>
                      <dd className="mt-1 text-lg font-semibold">
                        {generation.counters.scanned ?? 0}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Imported</dt>
                      <dd className="mt-1 text-lg font-semibold">
                        {generation.counters.imported ?? 0}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Failed</dt>
                      <dd className="mt-1 text-lg font-semibold">
                        {generation.counters.failed ?? 0}
                      </dd>
                    </div>
                  </dl>
                  {generation.status === 'FAILED' ? (
                    <p className="mt-4 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
                      {generation.errorCode ?? 'The build failed'}. The previous
                      live index was not replaced.
                    </p>
                  ) : null}
                </div>
              )}
              {error ? (
                <p
                  className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
            <Button
              disabled={step === 0 || busy}
              onClick={() => setStep((current) => current - 1)}
              variant="ghost"
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button
                disabled={!canContinue}
                onClick={() => setStep((current) => current + 1)}
              >
                Continue
                <ArrowRight className="size-4" />
              </Button>
            ) : generation?.status === 'ACTIVE' ? (
              <Button asChild>
                <Link href={`/?view=sources&project=${projectId}`}>
                  Return to sources
                </Link>
              </Button>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
