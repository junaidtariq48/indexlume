'use client';

import {
  Cable,
  Database,
  FileText,
  PlayCircle,
  Plus,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { apiRequest } from '../../lib/api';
import type {
  IngestionRun,
  ListResponse,
  PostgresDataset,
  PostgresSource,
  Project,
  ProjectionReconciliation,
  SearchIndex,
  SourceProjection,
  UploadSource,
} from '../console-model';
import { Empty, ErrorState, LoadingState, State } from '../feature-primitives';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { ConfirmDialog, DialogFrame } from '../ui/dialog';
import { Input } from '../ui/input';

function PostgresSourceWizard({
  project,
  indexes,
  canManage,
  onChanged,
  onClean,
  onDirty,
}: {
  project?: Project;
  indexes: SearchIndex[];
  canManage: boolean;
  onChanged: () => void | Promise<void>;
  onClean?: () => void;
  onDirty?: () => void;
}) {
  const [sources, setSources] = useState<PostgresSource[]>([]);
  const [name, setName] = useState('Product database');
  const [connectionUrl, setConnectionUrl] = useState('');
  const [tlsPolicy, setTlsPolicy] = useState<'STRICT' | 'ALLOW_INSECURE'>(
    'STRICT',
  );
  const [sourceId, setSourceId] = useState('');
  const [datasets, setDatasets] = useState<PostgresDataset[]>([]);
  const [datasetKey, setDatasetKey] = useState('');
  const [primaryKeyField, setPrimaryKeyField] = useState('');
  const [updatedAtField, setUpdatedAtField] = useState('');
  const [deletedAtField, setDeletedAtField] = useState('');
  const [indexId, setIndexId] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState<5 | 15 | 60>(15);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [confirmReconcileOpen, setConfirmReconcileOpen] = useState(false);
  const [reconcile, setReconcile] = useState<{
    runId: string;
    token: string;
  } | null>(null);
  const selectedDataset = datasets.find(
    (item) => `${item.schemaName}.${item.tableName}` === datasetKey,
  );
  const selectedSource = sources.find((source) => source.id === sourceId);
  const selectedSchedule =
    selectedSource?.searchIndexes.find((index) => index.id === indexId)
      ?.scheduledSync ??
    selectedSource?.searchIndexes.find((index) => index.scheduledSync)
      ?.scheduledSync;
  const load = useCallback(async () => {
    if (!project) return setSources([]);
    const response = await apiRequest<ListResponse<PostgresSource>>(
      `/projects/${project.id}/sources`,
    );
    const postgres = response.data.filter((item) => item.type === 'POSTGRES');
    setSources(postgres);
    setSourceId((current) => current || postgres[0]?.id || '');
  }, [project]);
  useEffect(() => void load(), [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    setMessage('Testing the read-only connection…');
    setMessageError(false);
    setBusyAction('create');
    try {
      const created = await apiRequest<PostgresSource>(
        `/projects/${project.id}/sources`,
        {
          method: 'POST',
          body: JSON.stringify({ name, connectionUrl, tlsPolicy }),
        },
      );
      setConnectionUrl('');
      setSourceId(created.id);
      setMessage('Connection verified. Choose an allowlisted dataset.');
      await load();
      await onChanged();
      onClean?.();
      await discover(created.id);
    } catch (caught) {
      setMessageError(true);
      setMessage(
        caught instanceof Error ? caught.message : 'Connection test failed',
      );
    } finally {
      setBusyAction('');
    }
  }

  async function discover(id = sourceId) {
    if (!id) return;
    setMessage('Discovering readable tables and views…');
    setMessageError(false);
    setBusyAction('discover');
    try {
      const response = await apiRequest<ListResponse<PostgresDataset>>(
        `/sources/${id}/datasets`,
      );
      setDatasets(response.data);
      const first = response.data[0];
      if (first) {
        chooseDataset(first);
        onDirty?.();
      }
      setMessage(
        response.data.length
          ? 'Select the key, update cursor, optional tombstone, and index.'
          : 'No readable datasets were found.',
      );
    } catch (caught) {
      setMessageError(true);
      setMessage(caught instanceof Error ? caught.message : 'Discovery failed');
    } finally {
      setBusyAction('');
    }
  }

  function chooseDataset(dataset: PostgresDataset) {
    setDatasetKey(`${dataset.schemaName}.${dataset.tableName}`);
    setPrimaryKeyField(
      dataset.columns.find((column) => column.name === 'id')?.name ??
        dataset.columns.find((column) => !column.nullable)?.name ??
        '',
    );
    setUpdatedAtField(
      dataset.columns.find((column) => column.name === 'updated_at')?.name ??
        dataset.columns.find((column) => column.dataType.includes('timestamp'))
          ?.name ??
        '',
    );
    setDeletedAtField(
      dataset.columns.find((column) => column.name === 'deleted_at')?.name ??
        '',
    );
  }

  async function previewRows() {
    if (!selectedDataset || !sourceId || !primaryKeyField) return;
    setBusyAction('preview');
    setMessageError(false);
    try {
      const response = await apiRequest<{
        rows: Array<Record<string, unknown>>;
      }>(`/sources/${sourceId}/preview`, {
        method: 'POST',
        body: JSON.stringify({
          schemaName: selectedDataset.schemaName,
          tableName: selectedDataset.tableName,
          fields: selectedDataset.columns.map((column) => column.name),
          primaryKeyField,
        }),
      });
      setPreview(response.rows);
      setMessage(`Previewed ${response.rows.length} rows (maximum 20).`);
    } catch (caught) {
      setMessageError(true);
      setMessage(caught instanceof Error ? caught.message : 'Preview failed');
    } finally {
      setBusyAction('');
    }
  }

  async function save() {
    if (
      !selectedDataset ||
      !sourceId ||
      !primaryKeyField ||
      !updatedAtField ||
      !indexId
    )
      return;
    setBusyAction('save');
    setMessageError(false);
    try {
      await apiRequest(`/sources/${sourceId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schemaName: selectedDataset.schemaName,
          tableName: selectedDataset.tableName,
          primaryKeyField,
          updatedAtField,
          ...(deletedAtField ? { deletedAtField } : {}),
          fieldAllowlist: selectedDataset.columns.map((column) => column.name),
          searchIndexId: indexId,
          intervalMinutes,
        }),
      });
      setMessage('Source mapping and schedule saved. Run the initial import.');
      await load();
      await onChanged();
      onClean?.();
    } catch (caught) {
      setMessageError(true);
      setMessage(caught instanceof Error ? caught.message : 'Save failed');
    } finally {
      setBusyAction('');
    }
  }

  async function run(operation: 'sync' | 'rebuild') {
    if (!indexId) return;
    setBusyAction(operation);
    setMessageError(false);
    try {
      await apiRequest(`/indexes/${indexId}/${operation}`, {
        method: 'POST',
        ...(operation === 'rebuild'
          ? {
              body: JSON.stringify({ sourceId }),
              headers: { 'content-type': 'application/json' },
            }
          : {}),
      });
      setMessage(
        operation === 'sync'
          ? 'Incremental synchronization queued.'
          : 'Keyset snapshot and full reindex queued.',
      );
    } catch (caught) {
      setMessageError(true);
      setMessage(caught instanceof Error ? caught.message : 'Queue failed');
    } finally {
      setBusyAction('');
    }
  }

  async function previewReconcile() {
    if (!indexId) return;
    setBusyAction('reconcile-preview');
    setMessageError(false);
    try {
      const response = await apiRequest<{
        run: { id: string };
        token: string;
      }>(`/indexes/${indexId}/reconcile/preview`, { method: 'POST' });
      setReconcile({ runId: response.run.id, token: response.token });
      setMessage(
        'Reconciliation scan queued. Refresh its preview when complete.',
      );
    } catch (caught) {
      setMessageError(true);
      setMessage(caught instanceof Error ? caught.message : 'Preview failed');
    } finally {
      setBusyAction('');
    }
  }

  async function refreshReconcile() {
    if (!reconcile) return;
    setBusyAction('reconcile-refresh');
    setMessageError(false);
    try {
      const response = await apiRequest<{
        complete: boolean;
        failureReason?: string | null;
        missingIds: string[];
      }>(`/runs/${reconcile.runId}/reconciliation`);
      setMessage(
        response.complete
          ? `${response.missingIds.length} indexed documents are absent from PostgreSQL. Confirm to delete them.`
          : (response.failureReason ??
              'Source scan is still running. No deletion is allowed.'),
      );
    } catch (caught) {
      setMessageError(true);
      setMessage(caught instanceof Error ? caught.message : 'Refresh failed');
    } finally {
      setBusyAction('');
    }
  }

  async function executeReconcile() {
    if (!reconcile || !indexId) return;
    setBusyAction('reconcile-execute');
    setMessageError(false);
    try {
      await apiRequest(`/indexes/${indexId}/reconcile/execute`, {
        method: 'POST',
        body: JSON.stringify({ token: reconcile.token }),
      });
      setReconcile(null);
      setConfirmReconcileOpen(false);
      setMessage('Confirmed reconciliation deletion queued.');
    } catch (caught) {
      setMessageError(true);
      setMessage(
        caught instanceof Error ? caught.message : 'Reconciliation blocked',
      );
    } finally {
      setBusyAction('');
    }
  }

  return (
    <div className="space-y-6">
      {sources.length > 0 && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="text-sm font-medium">
              Saved PostgreSQL source
              <Combobox
                ariaLabel="Saved PostgreSQL source"
                className="mt-2"
                value={sourceId}
                onValueChange={(value) => {
                  setSourceId(value);
                  setDatasets([]);
                  setPreview([]);
                }}
                options={sources.map((source) => ({
                  value: source.id,
                  label: source.name,
                  group: source.state,
                  keywords: [String(source.errorCount), 'errors'],
                }))}
                searchPlaceholder="Search saved sources…"
              />
            </label>
            <button
              className="secondary-button"
              disabled={Boolean(busyAction)}
              onClick={() => void discover()}
              type="button"
            >
              {busyAction === 'discover' ? 'Discovering…' : 'Test and discover'}
            </button>
          </div>
          {selectedSource && (
            <div className="grid gap-2 rounded-lg bg-background p-3 text-xs text-muted-foreground sm:grid-cols-4">
              <span>Type: POSTGRES</span>
              <span>
                Last test:{' '}
                {selectedSource.lastTestedAt
                  ? new Date(selectedSource.lastTestedAt).toLocaleString()
                  : 'Never'}
              </span>
              <span>
                Last sync:{' '}
                {selectedSource.lastSyncAt
                  ? new Date(selectedSource.lastSyncAt).toLocaleString()
                  : 'Never'}
              </span>
              <span>
                Next sync:{' '}
                {selectedSchedule
                  ? new Date(selectedSchedule.nextRunAt).toLocaleString()
                  : 'Not scheduled'}
              </span>
              {selectedSource.lastError && (
                <span className="text-destructive sm:col-span-4">
                  {selectedSource.lastError}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {canManage && (
        <form
          onSubmit={create}
          className="grid gap-3 border-t border-border pt-5 sm:grid-cols-2"
        >
          <label className="text-sm font-medium">
            Source name
            <input
              className="field mt-2"
              onChange={(event) => {
                setName(event.target.value);
                onDirty?.();
              }}
              required
              value={name}
            />
          </label>
          <label className="text-sm font-medium">
            TLS policy
            <Combobox
              ariaLabel="TLS policy"
              className="mt-2"
              onValueChange={(value) => {
                setTlsPolicy(value as 'STRICT' | 'ALLOW_INSECURE');
                onDirty?.();
              }}
              options={[
                {
                  value: 'STRICT',
                  label: 'TLS certificate required',
                  group: 'Security',
                },
                {
                  value: 'ALLOW_INSECURE',
                  label: 'Allow insecure (deployment opt-in)',
                  group: 'Security',
                },
              ]}
              value={tlsPolicy}
            />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            PostgreSQL connection URL
            <input
              autoComplete="new-password"
              className="field mt-2"
              onChange={(event) => {
                setConnectionUrl(event.target.value);
                onDirty?.();
              }}
              placeholder="postgresql://readonly:password@host:5432/database"
              required
              type="password"
              value={connectionUrl}
            />
          </label>
          <button
            className="action-button sm:col-span-2"
            disabled={Boolean(busyAction)}
            type="submit"
          >
            <Plus className="size-4" />
            {busyAction === 'create'
              ? 'Testing connection…'
              : 'Test and save connection'}
          </button>
        </form>
      )}
      {selectedDataset || datasets.length ? (
        <div className="grid gap-3 border-t border-border pt-5 sm:grid-cols-2">
          <label className="text-sm font-medium sm:col-span-2">
            Dataset
            <Combobox
              ariaLabel="Dataset"
              className="mt-2"
              value={datasetKey}
              onValueChange={(value) => {
                const chosen = datasets.find(
                  (item) => `${item.schemaName}.${item.tableName}` === value,
                );
                if (chosen) {
                  chooseDataset(chosen);
                  onDirty?.();
                }
              }}
              options={datasets.map((dataset) => ({
                value: `${dataset.schemaName}.${dataset.tableName}`,
                label: `${dataset.schemaName}.${dataset.tableName}`,
                group: dataset.kind,
              }))}
              searchPlaceholder="Search tables and views…"
            />
          </label>
          <label className="text-sm font-medium">
            Stable primary key
            <Combobox
              ariaLabel="Stable primary key"
              className="mt-2"
              value={primaryKeyField}
              onValueChange={(value) => {
                setPrimaryKeyField(value);
                onDirty?.();
              }}
              options={[
                { value: '', label: 'Stable primary key' },
                ...(selectedDataset?.columns.map((column) => ({
                  value: column.name,
                  label: column.name,
                  group: column.dataType,
                })) ?? []),
              ]}
              searchPlaceholder="Search columns…"
            />
          </label>
          <label className="text-sm font-medium">
            Updated-at cursor
            <Combobox
              ariaLabel="Updated-at cursor"
              className="mt-2"
              value={updatedAtField}
              onValueChange={(value) => {
                setUpdatedAtField(value);
                onDirty?.();
              }}
              options={[
                { value: '', label: 'updated_at cursor' },
                ...(selectedDataset?.columns
                  .filter((column) => column.dataType.includes('timestamp'))
                  .map((column) => ({
                    value: column.name,
                    label: column.name,
                    group: 'Timestamp columns',
                  })) ?? []),
              ]}
              searchPlaceholder="Search timestamp columns…"
            />
          </label>
          <label className="text-sm font-medium">
            Soft-delete marker
            <Combobox
              ariaLabel="Soft-delete marker"
              className="mt-2"
              value={deletedAtField}
              onValueChange={(value) => {
                setDeletedAtField(value);
                onDirty?.();
              }}
              options={[
                { value: '', label: 'No soft-delete marker' },
                ...(selectedDataset?.columns.map((column) => ({
                  value: column.name,
                  label: column.name,
                  group: column.dataType,
                })) ?? []),
              ]}
              searchPlaceholder="Search columns…"
            />
          </label>
          <label className="text-sm font-medium">
            Collection
            <Combobox
              ariaLabel="Collection"
              className="mt-2"
              value={indexId}
              onValueChange={(value) => {
                setIndexId(value);
                onDirty?.();
              }}
              options={[
                { value: '', label: 'Map to index' },
                ...indexes.map((index) => ({
                  value: index.id,
                  label: index.name,
                  group: 'Collections',
                  keywords: [index.slug],
                })),
              ]}
              searchPlaceholder="Search collections…"
            />
          </label>
          <label className="text-sm font-medium">
            Sync schedule
            <Combobox
              ariaLabel="Sync schedule"
              className="mt-2"
              value={String(intervalMinutes)}
              onValueChange={(value) => {
                setIntervalMinutes(Number(value) as 5 | 15 | 60);
                onDirty?.();
              }}
              options={[
                { value: '5', label: 'Every 5 minutes' },
                { value: '15', label: 'Every 15 minutes' },
                { value: '60', label: 'Every 60 minutes' },
              ]}
            />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button
              className="secondary-button"
              disabled={Boolean(busyAction)}
              onClick={() => void previewRows()}
              type="button"
            >
              {busyAction === 'preview' ? 'Previewing…' : 'Preview up to 20'}
            </button>
            {canManage && (
              <button
                className="action-button"
                disabled={Boolean(busyAction)}
                onClick={() => void save()}
                type="button"
              >
                {busyAction === 'save'
                  ? 'Saving…'
                  : 'Save mapping and schedule'}
              </button>
            )}
          </div>
        </div>
      ) : null}
      {preview.length > 0 && (
        <pre className="max-h-72 overflow-auto rounded-lg bg-background p-4 text-xs">
          {JSON.stringify(preview, null, 2)}
        </pre>
      )}
      {canManage && indexId && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-5">
          <button
            className="secondary-button"
            disabled={Boolean(busyAction)}
            onClick={() => void run('rebuild')}
            type="button"
          >
            {busyAction === 'rebuild'
              ? 'Queuing…'
              : 'Initial import / full reindex'}
          </button>
          <button
            className="secondary-button"
            disabled={Boolean(busyAction)}
            onClick={() => void run('sync')}
            type="button"
          >
            {busyAction === 'sync' ? 'Queuing…' : 'Sync now'}
          </button>
          <button
            className="secondary-button"
            disabled={Boolean(busyAction)}
            onClick={() => void previewReconcile()}
            type="button"
          >
            Preview hard deletes
          </button>
          {reconcile && (
            <>
              <button
                className="secondary-button"
                disabled={Boolean(busyAction)}
                onClick={() => void refreshReconcile()}
                type="button"
              >
                Refresh preview
              </button>
              <button
                className="secondary-button"
                disabled={Boolean(busyAction)}
                onClick={() => setConfirmReconcileOpen(true)}
                type="button"
              >
                Confirm reconciliation
              </button>
            </>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Timestamp polling uses a two-second overlap and stable key tie-breaker.
        Physical deletes require a completed reconciliation preview; failed or
        incomplete scans cannot delete documents.
      </p>
      {message && (
        <p
          className={
            messageError ? 'text-sm text-destructive' : 'text-sm text-primary'
          }
          role={messageError ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
      <ConfirmDialog
        busy={busyAction === 'reconcile-execute'}
        confirmLabel="Delete missing documents"
        description="This queues deletion of indexed documents confirmed absent by the completed reconciliation preview. This action cannot be undone."
        onConfirm={executeReconcile}
        onOpenChange={setConfirmReconcileOpen}
        open={confirmReconcileOpen}
        title="Confirm reconciliation deletion"
        variant="destructive"
      />
    </div>
  );
}
export function SourcesView({
  project,
  indexes,
  canManage,
}: {
  project?: Project;
  indexes: SearchIndex[];
  canManage: boolean;
}) {
  const [uploads, setUploads] = useState<UploadSource[]>([]);
  const [postgresSources, setPostgresSources] = useState<PostgresSource[]>([]);
  const [projections, setProjections] = useState<SourceProjection[]>([]);
  const [projectionsEnabled, setProjectionsEnabled] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<'file' | 'postgres' | null>(null);
  const [addDirty, setAddDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('Product upload');
  const [format, setFormat] = useState<'CSV' | 'JSONL'>('CSV');
  const [selectedIndex, setSelectedIndex] = useState('');
  const [idField, setIdField] = useState('id');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reconcileProjection, setReconcileProjection] =
    useState<SourceProjection | null>(null);
  const [reconciliation, setReconciliation] =
    useState<ProjectionReconciliation | null>(null);
  const [reconcileCount, setReconcileCount] = useState('');
  const [reconcileBusy, setReconcileBusy] = useState(false);

  const load = useCallback(async () => {
    if (!project) {
      setUploads([]);
      setPostgresSources([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const [uploadResponse, sourceResponse, projectionResponse] =
        await Promise.all([
          apiRequest<ListResponse<UploadSource>>(
            `/projects/${project.id}/uploads`,
          ),
          apiRequest<ListResponse<PostgresSource>>(
            `/projects/${project.id}/sources`,
          ),
          apiRequest<
            ListResponse<SourceProjection> & { meta: { enabled: boolean } }
          >(`/projects/${project.id}/projections`),
        ]);
      const postgres = sourceResponse.data.filter(
        (item) => item.type === 'POSTGRES',
      );
      setUploads(uploadResponse.data);
      setPostgresSources(postgres);
      setProjections(projectionResponse.data);
      setProjectionsEnabled(projectionResponse.meta.enabled);
      setSelectedKey(
        (current) =>
          current ||
          (postgres[0] ? `postgres:${postgres[0].id}` : '') ||
          (uploadResponse.data[0] ? `upload:${uploadResponse.data[0].id}` : ''),
      );
    } catch (caught) {
      setLoadError(
        caught instanceof Error ? caught.message : 'Could not load sources',
      );
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedUpload = uploads.find(
    (item) => selectedKey === `upload:${item.id}`,
  );
  const selectedPostgres = postgresSources.find(
    (item) => selectedKey === `postgres:${item.id}`,
  );
  const sourceCount = uploads.length + postgresSources.length;
  const selectedProjections = projections.filter(
    (item) => item.sourceId === selectedPostgres?.id,
  );

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!project || !file) return;
    setBusy(true);
    setMessage('');
    const data = new FormData();
    data.set('name', name);
    data.set('format', format);
    data.set('file', file);
    try {
      const created = await apiRequest<UploadSource>(
        `/projects/${project.id}/uploads`,
        { method: 'POST', body: data },
      );
      setUploads((items) => [created, ...items]);
      setSelectedKey(`upload:${created.id}`);
      setIdField(
        created.schema.find((field) => field.name === 'id')?.name ??
          created.schema[0]?.name ??
          '',
      );
      setFile(null);
      setAddDirty(false);
      setAddOpen(false);
      setAddType(null);
      setMessage(
        `Validated ${created.rowCount} records. The source is ready to build a collection generation.`,
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function rebuild() {
    if (!selectedIndex || !selectedUpload || !idField) return;
    setBusy(true);
    try {
      const run = await apiRequest<IngestionRun>(
        `/indexes/${selectedIndex}/rebuild`,
        {
          method: 'POST',
          body: JSON.stringify({
            sourceId: selectedUpload.id,
            idField,
          }),
        },
      );
      setMessage(`Generation ${run.generation?.generation ?? 'new'} queued.`);
    } catch (caught) {
      setMessage(
        caught instanceof Error ? caught.message : 'Could not queue rebuild',
      );
    } finally {
      setBusy(false);
    }
  }

  async function syncProjection(projection: SourceProjection) {
    if (!project) return;
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(
        `/projects/${project.id}/projections/${projection.id}/sync`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        },
      );
      setMessage(`Incremental synchronization queued for ${projection.name}.`);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Queue failed');
    } finally {
      setBusy(false);
    }
  }

  const refreshReconciliation = useCallback(
    async (projectionId: string, runId: string) => {
      if (!project) return;
      const result = await apiRequest<ProjectionReconciliation>(
        `/projects/${project.id}/projections/${projectionId}/reconcile/${runId}`,
      );
      setReconciliation(result);
      if (result.status === 'AWAITING_CONFIRMATION') {
        setReconcileCount('');
      }
    },
    [project],
  );

  useEffect(() => {
    if (
      !reconcileProjection ||
      !reconciliation ||
      !['QUEUED', 'SCANNING', 'EXECUTING'].includes(reconciliation.status)
    )
      return;
    const timer = window.setTimeout(() => {
      void refreshReconciliation(reconcileProjection.id, reconciliation.id);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [reconcileProjection, reconciliation, refreshReconciliation]);

  async function startReconciliation(projection: SourceProjection) {
    if (!project) return;
    setReconcileProjection(projection);
    setReconciliation(null);
    setReconcileBusy(true);
    setMessage('');
    try {
      const result = await apiRequest<ProjectionReconciliation>(
        `/projects/${project.id}/projections/${projection.id}/reconcile/preview`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        },
      );
      setReconciliation(result);
    } catch (caught) {
      setMessage(
        caught instanceof Error
          ? caught.message
          : 'Could not start reconciliation',
      );
      setReconcileProjection(null);
    } finally {
      setReconcileBusy(false);
    }
  }

  async function confirmProjectionReconciliation() {
    if (!project || !reconcileProjection || !reconciliation?.confirmationToken)
      return;
    setReconcileBusy(true);
    try {
      const result = await apiRequest<ProjectionReconciliation>(
        `/projects/${project.id}/projections/${reconcileProjection.id}/reconcile/${reconciliation.id}/confirm`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            token: reconciliation.confirmationToken,
            expectedCount: reconciliation.expectedCount,
          }),
        },
      );
      setReconciliation(result);
      setMessage(
        `Confirmed deletion of ${reconciliation.expectedCount} stale documents for ${reconcileProjection.name}.`,
      );
    } catch (caught) {
      setMessage(
        caught instanceof Error
          ? caught.message
          : 'Could not confirm reconciliation',
      );
    } finally {
      setReconcileBusy(false);
    }
  }

  function setDialogOpen(open: boolean) {
    if (!open && addDirty && !busy) {
      setAddOpen(false);
      setDiscardOpen(true);
      return;
    }
    setAddOpen(open);
    if (!open) {
      setAddDirty(false);
      setAddType(null);
    }
  }

  function discardSetup() {
    setDiscardOpen(false);
    setAddDirty(false);
    setAddOpen(false);
    setAddType(null);
    setFile(null);
  }

  function setDiscardDialogOpen(open: boolean) {
    setDiscardOpen(open);
    if (!open && addDirty) setAddOpen(true);
  }

  if (!project)
    return (
      <Empty
        title="Select a project"
        detail="Choose a project before managing data sources."
      />
    );
  if (loading && !sourceCount)
    return <LoadingState label="Loading data sources" />;
  if (loadError && !sourceCount)
    return (
      <ErrorState
        detail={loadError}
        onRetry={() => void load()}
        title="Data sources unavailable"
      />
    );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {sourceCount
            ? `${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'} connected`
            : 'No data sources connected'}
        </p>
        {canManage && sourceCount ? (
          <Button onClick={() => setDialogOpen(true)} type="button">
            <Plus className="size-4" /> Add data source
          </Button>
        ) : null}
      </div>

      {message ? (
        <p
          className="rounded-md border border-border bg-card p-3 text-sm text-foreground"
          role="status"
        >
          {message}
        </p>
      ) : null}

      {!sourceCount ? (
        <section className="rounded-xl border border-dashed border-border p-12 text-center">
          <Database className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-4 font-medium">Connect your first data source</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
            Upload a validated CSV or JSONL file, or connect a read-only
            PostgreSQL dataset.
          </p>
          {canManage ? (
            <Button
              className="mt-5"
              onClick={() => setDialogOpen(true)}
              type="button"
            >
              Add data source
            </Button>
          ) : null}
        </section>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <section
            aria-label="Data sources"
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            {[...postgresSources, ...uploads].map((source) => {
              const postgres = 'type' in source && source.type === 'POSTGRES';
              const key = postgres
                ? `postgres:${source.id}`
                : `upload:${source.id}`;
              return (
                <button
                  aria-current={selectedKey === key ? 'true' : undefined}
                  className={`block w-full border-b border-border px-4 py-4 text-left last:border-b-0 ${
                    selectedKey === key ? 'bg-accent' : 'hover:bg-muted'
                  }`}
                  key={key}
                  onClick={() => setSelectedKey(key)}
                  type="button"
                >
                  <span className="flex items-center gap-3">
                    {postgres ? (
                      <Cable className="size-4 text-muted-foreground" />
                    ) : (
                      <FileText className="size-4 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {source.name}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {'format' in source ? source.format : 'PostgreSQL'}
                      </span>
                    </span>
                    {postgres ? <State value={source.state} /> : null}
                  </span>
                </button>
              );
            })}
          </section>

          {selectedPostgres ? (
            <section className="rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">
                      {selectedPostgres.name}
                    </h2>
                    <State value={selectedPostgres.state} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Read-only PostgreSQL source
                  </p>
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    {projectionsEnabled ? (
                      <Button asChild>
                        <Link
                          href={`/sources/${selectedPostgres.id}/projections/new?project=${project.id}`}
                        >
                          <Plus className="size-4" /> Create dataset
                        </Link>
                      </Button>
                    ) : null}
                    <Button
                      onClick={() => {
                        setAddType('postgres');
                        setAddOpen(true);
                      }}
                      type="button"
                      variant="outline"
                    >
                      Manage source
                    </Button>
                  </div>
                ) : null}
              </div>
              <dl className="grid gap-px bg-border sm:grid-cols-3">
                <SourceFact
                  label="Datasets"
                  value={String(selectedPostgres.datasets.length)}
                />
                <SourceFact
                  label="Last sync"
                  value={
                    selectedPostgres.lastSyncAt
                      ? new Date(selectedPostgres.lastSyncAt).toLocaleString()
                      : 'Never'
                  }
                />
                <SourceFact
                  label="Errors"
                  value={String(selectedPostgres.errorCount)}
                />
              </dl>
              <div className="p-5">
                <h3 className="text-sm font-semibold">Selected datasets</h3>
                {selectedPostgres.datasets.length ? (
                  <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
                    {selectedPostgres.datasets.map((dataset) => (
                      <li
                        className="px-4 py-3 font-mono text-xs"
                        key={`${dataset.schemaName}.${dataset.tableName}`}
                      >
                        {dataset.schemaName}.{dataset.tableName}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No dataset mapping has been saved yet.
                  </p>
                )}
                {projectionsEnabled ? (
                  <div className="mt-6 border-t border-border pt-5">
                    <h3 className="text-sm font-semibold">
                      Relational datasets
                    </h3>
                    {selectedProjections.length ? (
                      <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
                        {selectedProjections.map((item) => (
                          <li
                            className="flex items-center justify-between gap-4 px-4 py-3"
                            key={item.id}
                          >
                            <span>
                              <span className="block text-sm font-medium">
                                {item.name}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {item.searchIndex.name}
                              </span>
                            </span>
                            <span className="flex items-center gap-2">
                              <State
                                value={item.draftVersion?.status ?? item.status}
                              />
                              {canManage && item.status === 'PUBLISHED' ? (
                                <>
                                  <Button
                                    disabled={busy || reconcileBusy}
                                    onClick={() =>
                                      void startReconciliation(item)
                                    }
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    Reconcile
                                  </Button>
                                  <Button
                                    disabled={busy || reconcileBusy}
                                    onClick={() => void syncProjection(item)}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    Sync now
                                  </Button>
                                </>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">
                        No multi-table dataset has been configured for this
                        source.
                      </p>
                    )}
                  </div>
                ) : null}
                {selectedPostgres.lastError ? (
                  <p className="mt-4 text-sm text-destructive">
                    {selectedPostgres.lastError}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {selectedUpload ? (
            <section className="rounded-xl border border-border bg-card">
              <div className="border-b border-border p-5">
                <h2 className="text-lg font-semibold">{selectedUpload.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedUpload.originalName} · {selectedUpload.rowCount}{' '}
                  records · {selectedUpload.format}
                </p>
              </div>
              <div className="space-y-6 p-5">
                <div>
                  <h3 className="text-sm font-semibold">Build a generation</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The collection alias switches only after every record
                    imports successfully.
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-medium">
                      Collection
                      <Combobox
                        ariaLabel="Collection"
                        className="mt-2"
                        onValueChange={setSelectedIndex}
                        options={[
                          { value: '', label: 'Select collection' },
                          ...indexes.map((item) => ({
                            value: item.id,
                            label: item.name,
                            group: 'Collections',
                            keywords: [item.slug],
                          })),
                        ]}
                        searchPlaceholder="Search collections…"
                        value={selectedIndex}
                      />
                    </label>
                    <label className="text-sm font-medium">
                      Document ID field
                      <Combobox
                        ariaLabel="Document ID field"
                        className="mt-2"
                        onValueChange={setIdField}
                        options={[
                          { value: '', label: 'Select ID field' },
                          ...selectedUpload.schema.map((field) => ({
                            value: field.name,
                            label: field.name,
                            group: field.type,
                          })),
                        ]}
                        searchPlaceholder="Search fields…"
                        value={idField}
                      />
                    </label>
                  </div>
                  {canManage ? (
                    <Button
                      className="mt-4"
                      disabled={!selectedIndex || !idField || busy}
                      onClick={() => void rebuild()}
                      type="button"
                    >
                      <PlayCircle className="size-4" />
                      {busy ? 'Queuing…' : 'Queue rebuild'}
                    </Button>
                  ) : null}
                </div>
                <div className="border-t border-border pt-5">
                  <h3 className="text-sm font-semibold">Detected schema</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedUpload.schema.map((field) => (
                      <span
                        className="rounded-md bg-muted px-2 py-1 font-mono text-xs"
                        key={field.name}
                      >
                        {field.name}:{field.type}
                      </span>
                    ))}
                  </div>
                </div>
                {selectedUpload.preview ? (
                  <details className="border-t border-border pt-5">
                    <summary className="cursor-pointer text-sm font-medium">
                      Preview validated records
                    </summary>
                    <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-background p-4 text-xs">
                      {JSON.stringify(selectedUpload.preview, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <DialogFrame
        description={
          addType === 'file'
            ? 'Files are validated before encrypted private staging.'
            : addType === 'postgres'
              ? 'Use a read-only PostgreSQL account, then select an allowlisted dataset and stable cursor.'
              : 'Choose how this project should receive searchable data.'
        }
        onOpenChange={setDialogOpen}
        open={addOpen}
        size={addType === 'postgres' ? 'xl' : 'md'}
        title={
          addType === 'file'
            ? 'Upload file source'
            : addType === 'postgres'
              ? 'Configure PostgreSQL source'
              : 'Add data source'
        }
      >
        {!addType ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <button
              className="rounded-lg border border-border p-5 text-left hover:border-primary hover:bg-accent"
              onClick={() => setAddType('file')}
              type="button"
            >
              <Upload className="size-5 text-primary" />
              <span className="mt-4 block font-medium">Upload a file</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Validate and stage a CSV or JSONL file.
              </span>
            </button>
            <button
              className="rounded-lg border border-border p-5 text-left hover:border-primary hover:bg-accent"
              onClick={() => setAddType('postgres')}
              type="button"
            >
              <Cable className="size-5 text-primary" />
              <span className="mt-4 block font-medium">Connect PostgreSQL</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Discover and synchronize a read-only dataset.
              </span>
            </button>
          </div>
        ) : null}

        {addType === 'file' ? (
          <form className="mt-5 space-y-4" onSubmit={upload}>
            <label className="block text-sm font-medium">
              Source name
              <Input
                autoFocus
                className="mt-2"
                onChange={(event) => {
                  setName(event.target.value);
                  setAddDirty(true);
                }}
                required
                value={name}
              />
            </label>
            <label className="block text-sm font-medium">
              Format
              <Combobox
                ariaLabel="File format"
                className="mt-2"
                onValueChange={(value) => {
                  setFormat(value as 'CSV' | 'JSONL');
                  setAddDirty(true);
                }}
                options={[
                  { value: 'CSV', label: 'CSV', group: 'File formats' },
                  { value: 'JSONL', label: 'JSONL', group: 'File formats' },
                ]}
                value={format}
              />
            </label>
            <label className="block text-sm font-medium">
              File
              <input
                accept={
                  format === 'CSV'
                    ? '.csv,text/csv'
                    : '.jsonl,application/x-ndjson'
                }
                className="field mt-2"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setAddDirty(true);
                }}
                required
                type="file"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                disabled={busy}
                onClick={() => setAddType(null)}
                type="button"
                variant="outline"
              >
                Back
              </Button>
              <Button disabled={busy} type="submit">
                {busy ? 'Uploading…' : 'Upload and validate'}
              </Button>
            </div>
          </form>
        ) : null}

        {addType === 'postgres' ? (
          <div className="mt-6">
            <PostgresSourceWizard
              canManage={canManage}
              indexes={indexes}
              onChanged={load}
              onClean={() => setAddDirty(false)}
              onDirty={() => setAddDirty(true)}
              project={project}
            />
          </div>
        ) : null}
      </DialogFrame>
      <DialogFrame
        description="Reconciliation scans every eligible root and compares it with the active collection. Nothing is deleted until the complete scan is verified and you explicitly confirm the exact candidate count."
        onOpenChange={(open) => {
          if (!open) {
            setReconcileProjection(null);
            setReconciliation(null);
            setReconcileCount('');
          }
        }}
        open={Boolean(reconcileProjection)}
        size="lg"
        title={`Reconcile ${reconcileProjection?.name ?? 'dataset'}`}
      >
        <div className="mt-5 space-y-4">
          {!reconciliation ? (
            <LoadingState label="Starting complete source scan…" />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <SourceFact
                  label="Status"
                  value={reconciliation.status.replaceAll('_', ' ')}
                />
                <SourceFact
                  label="Eligible roots"
                  value={String(reconciliation.rootCount)}
                />
                <SourceFact
                  label="Delete candidates"
                  value={String(reconciliation.expectedCount)}
                />
              </div>
              {['QUEUED', 'SCANNING'].includes(reconciliation.status) ? (
                <LoadingState label="Scanning all source pages and checking relationship drift…" />
              ) : null}
              {reconciliation.status === 'COMPLETE' ? (
                <p className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                  The complete scan finished with no stale documents. No
                  deletion approval is required.
                </p>
              ) : null}
              {reconciliation.status === 'AWAITING_CONFIRMATION' ? (
                <div className="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                  <div>
                    <h3 className="text-sm font-semibold">
                      Review deletion candidates
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      This approval expires at{' '}
                      {reconciliation.expiresAt
                        ? new Date(reconciliation.expiresAt).toLocaleString()
                        : 'the displayed deadline'}
                      . Every candidate is checked against the source again
                      before deletion.
                    </p>
                  </div>
                  {reconciliation.candidates?.length ? (
                    <ul className="max-h-48 divide-y divide-border overflow-auto rounded-md border border-border bg-background">
                      {reconciliation.candidates.map((candidate) => (
                        <li className="px-3 py-2" key={candidate.id}>
                          <span className="block font-mono text-xs">
                            {redactDocumentId(candidate.documentId)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {candidate.reason.replaceAll('_', ' ')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <label className="block text-sm font-medium">
                    Type {reconciliation.expectedCount} to confirm
                    <Input
                      className="mt-2"
                      inputMode="numeric"
                      onChange={(event) =>
                        setReconcileCount(event.target.value)
                      }
                      value={reconcileCount}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={reconcileBusy}
                      onClick={() => setReconcileProjection(null)}
                      type="button"
                      variant="outline"
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={
                        reconcileBusy ||
                        reconcileCount !== String(reconciliation.expectedCount)
                      }
                      onClick={() => void confirmProjectionReconciliation()}
                      type="button"
                      variant="destructive"
                    >
                      {reconcileBusy
                        ? 'Confirming…'
                        : `Delete ${reconciliation.expectedCount} stale documents`}
                    </Button>
                  </div>
                </div>
              ) : null}
              {reconciliation.status === 'EXECUTING' ? (
                <LoadingState label="Double-checking candidates and applying approved deletions…" />
              ) : null}
              {reconciliation.status === 'EXECUTED' ? (
                <p className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                  Reconciliation finished. {reconciliation.expectedCount} stale
                  documents were removed.
                </p>
              ) : null}
              {reconciliation.status === 'INVALID' ? (
                <ErrorState
                  detail={
                    reconciliation.invalidReason ??
                    'The run was invalidated without deleting candidates.'
                  }
                  title="Reconciliation stopped safely"
                />
              ) : null}
            </>
          )}
        </div>
      </DialogFrame>
      <ConfirmDialog
        confirmLabel="Discard changes"
        description="Your unsaved data source setup will be lost."
        onConfirm={discardSetup}
        onOpenChange={setDiscardDialogOpen}
        open={discardOpen}
        title="Discard source setup?"
        variant="destructive"
      />
    </>
  );
}

function SourceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-sm font-medium">{value}</dd>
    </div>
  );
}

function redactDocumentId(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}•••`;
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
