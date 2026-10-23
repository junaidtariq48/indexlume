import { Injectable, Logger } from '@nestjs/common';
import { workerEnvironmentSchema, type IndexField } from '@osc/contracts';
import { createPrismaClient } from '@osc/db';
import { decryptEnvelope } from '@osc/ingestion';
import { Client } from 'pg';

const config = workerEnvironmentSchema.parse(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);

interface StoredPostgresConfig {
  connectionUrl: string;
  tlsPolicy: 'STRICT' | 'ALLOW_INSECURE';
}

type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

@Injectable()
export class PostgresSyncService {
  private readonly logger = new Logger(PostgresSyncService.name);

  async process(name: string, runId: string): Promise<void> {
    const run = await loadRun(runId);
    if (!run) return;
    try {
      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
          finishedAt: null,
          errorSummary: null,
          scanned: 0,
          succeeded: 0,
          failed: 0,
          deleted: 0,
        },
      });
      if (name === 'postgres-sync') await this.incremental(run);
      else if (name === 'postgres-rebuild') await this.snapshot(run);
      else if (name === 'reconcile-preview') await this.reconcilePreview(run);
      else if (name === 'reconcile-execute') await this.reconcileExecute(run);
      else throw new Error('Unsupported ingestion job');
    } catch (error) {
      if (error instanceof CancelledError) return;
      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          errorSummary:
            error instanceof SchemaDriftError
              ? 'SCHEMA_DRIFT: selected source columns changed'
              : 'PostgreSQL synchronization failed',
          finishedAt: new Date(),
        },
      });
      await prisma.dataSource.update({
        where: { id: run.sourceId },
        data: {
          state: 'ERROR',
          errorCount: { increment: 1 },
          lastError:
            error instanceof SchemaDriftError
              ? 'Selected source columns changed'
              : 'Synchronization dependency failed',
        },
      });
      const cursor = run.cursor as { reconciliationId?: string };
      if (name === 'reconcile-preview' && cursor.reconciliationId) {
        await prisma.reconciliationPreview.update({
          where: { id: cursor.reconciliationId },
          data: {
            complete: false,
            failureReason: 'Source scan did not complete',
          },
        });
      }
      this.logger.error(`PostgreSQL run ${run.id} failed`);
      throw error;
    }
  }

  private async incremental(run: LoadedRun) {
    const context = this.context(run);
    const client = await this.connect(context.stored);
    try {
      await this.assertSchema(client, context.dataset);
      const cursor = run.searchIndex.syncCursor?.value as
        { updatedAt?: string; primaryKey?: string } | undefined;
      const previousTime = cursor?.updatedAt
        ? new Date(cursor.updatedAt)
        : new Date(0);
      const startTime = new Date(Math.max(0, previousTime.getTime() - 2_000));
      const highWatermark = new Date();
      let pageTime = startTime;
      let pageKey = '';
      let scanned = 0;
      let succeeded = 0;
      let failed = 0;
      let deleted = 0;
      let maximumTime = previousTime;
      let maximumKey = cursor?.primaryKey ?? '';
      while (true) {
        await this.checkCancelled(run.id);
        const rows = await this.changePage(
          client,
          context.dataset,
          pageTime,
          pageKey,
          highWatermark,
        );
        if (!rows.length) break;
        const upserts: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          const key = String(row.__osc_pk);
          const changedAt = new Date(String(row.__osc_updated));
          pageTime = changedAt;
          pageKey = key;
          if (
            changedAt > maximumTime ||
            (changedAt.getTime() === maximumTime.getTime() && key > maximumKey)
          ) {
            maximumTime = changedAt;
            maximumKey = key;
          }
          scanned += 1;
          if (context.dataset.deletedAtField && row.__osc_deleted != null) {
            await tsDeleteDocument(
              context.credentials,
              run.searchIndex.alias,
              key,
            );
            deleted += 1;
          } else {
            upserts.push(this.document(row, key, context.mapping.fields));
          }
        }
        if (upserts.length) {
          const result = await tsImport(
            context.credentials,
            run.searchIndex.alias,
            upserts,
          );
          succeeded += result.succeeded;
          failed += result.failed;
        }
        await prisma.ingestionRun.update({
          where: { id: run.id },
          data: { scanned, succeeded, failed, deleted },
        });
        if (rows.length < config.INGEST_BATCH_DOCUMENTS) break;
      }
      if (failed) throw new Error('Typesense rejected source records');
      await prisma.$transaction([
        prisma.syncCursor.upsert({
          where: { searchIndexId: run.searchIndexId },
          create: {
            searchIndexId: run.searchIndexId,
            value: {
              updatedAt: maximumTime.toISOString(),
              primaryKey: maximumKey,
            },
            lastSuccessAt: new Date(),
          },
          update: {
            value: {
              updatedAt: maximumTime.toISOString(),
              primaryKey: maximumKey,
            },
            lastSuccessAt: new Date(),
          },
        }),
        prisma.ingestionRun.update({
          where: { id: run.id },
          data: {
            status: 'SUCCEEDED',
            finishedAt: new Date(),
            cursor: {
              updatedAt: maximumTime.toISOString(),
              primaryKey: maximumKey,
              overlapSeconds: 2,
            },
          },
        }),
        prisma.dataSource.update({
          where: { id: run.sourceId },
          data: {
            state: 'READY',
            lastSyncAt: new Date(),
            lastError: null,
          },
        }),
      ]);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async snapshot(run: LoadedRun) {
    const context = this.context(run);
    if (!run.generation || !run.generationId)
      throw new Error('Snapshot generation is missing');
    const collection = run.generation.physicalCollection;
    const client = await this.connect(context.stored);
    await tsDeleteCollection(context.credentials, collection);
    try {
      await this.assertSchema(client, context.dataset);
      await tsRequest(context.credentials, '/collections', {
        method: 'POST',
        body: JSON.stringify({
          name: collection,
          fields: context.mapping.fields.map((field) => ({
            name: field.name,
            type: field.type,
            facet: field.facet,
            optional: field.optional,
            sort: field.sort,
            index: field.searchable || field.facet || field.sort,
          })),
          ...(context.mapping.defaultSortingField
            ? { default_sorting_field: context.mapping.defaultSortingField }
            : {}),
        }),
      });
      let key = '';
      let scanned = 0;
      let succeeded = 0;
      let deleted = 0;
      while (true) {
        await this.checkCancelled(run.id);
        const rows = await this.snapshotPage(client, context.dataset, key);
        if (!rows.length) break;
        const documents: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          key = String(row.__osc_pk);
          scanned += 1;
          if (context.dataset.deletedAtField && row.__osc_deleted != null) {
            deleted += 1;
          } else {
            documents.push(this.document(row, key, context.mapping.fields));
          }
        }
        const result = documents.length
          ? await tsImport(context.credentials, collection, documents)
          : { succeeded: 0, failed: 0 };
        succeeded += result.succeeded;
        if (result.failed) throw new Error('Typesense rejected source records');
        await prisma.ingestionRun.update({
          where: { id: run.id },
          data: { scanned, succeeded, deleted, cursor: { primaryKey: key } },
        });
        if (rows.length < config.INGEST_BATCH_DOCUMENTS) break;
      }
      await tsRequest(
        context.credentials,
        `/aliases/${encodeURIComponent(run.searchIndex.alias)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ collection_name: collection }),
        },
      );
      await prisma.$transaction(async (transaction) => {
        await transaction.indexGeneration.updateMany({
          where: { searchIndexId: run.searchIndexId, state: 'ACTIVE' },
          data: { state: 'SUPERSEDED' },
        });
        await transaction.indexGeneration.update({
          where: { id: run.generationId! },
          data: {
            state: 'ACTIVE',
            recordCount: succeeded,
            activatedAt: new Date(),
          },
        });
        await transaction.searchIndex.update({
          where: { id: run.searchIndexId },
          data: {
            activeGeneration: run.generation!.generation,
            state: 'READY',
          },
        });
        await transaction.syncCursor.upsert({
          where: { searchIndexId: run.searchIndexId },
          create: { searchIndexId: run.searchIndexId, value: {} },
          update: { value: {} },
        });
        await transaction.ingestionRun.update({
          where: { id: run.id },
          data: { status: 'SUCCEEDED', finishedAt: new Date() },
        });
        await transaction.dataSource.update({
          where: { id: run.sourceId },
          data: {
            state: 'READY',
            lastSyncAt: new Date(),
            lastError: null,
          },
        });
      });
    } catch (error) {
      await tsDeleteCollection(context.credentials, collection).catch(
        () => undefined,
      );
      await prisma.indexGeneration.update({
        where: { id: run.generationId },
        data: { state: 'FAILED' },
      });
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async reconcilePreview(run: LoadedRun) {
    const context = this.context(run);
    const cursor = run.cursor as { reconciliationId?: string };
    if (!cursor.reconciliationId)
      throw new Error('Reconciliation preview is missing');
    const client = await this.connect(context.stored);
    try {
      await this.assertSchema(client, context.dataset);
      const sourceIds = new Set<string>();
      let key = '';
      while (true) {
        const rows = await this.idPage(client, context.dataset, key);
        if (!rows.length) break;
        for (const row of rows) {
          key = String(row.__osc_pk);
          if (!context.dataset.deletedAtField || row.__osc_deleted == null)
            sourceIds.add(key);
        }
        if (rows.length < config.INGEST_BATCH_DOCUMENTS) break;
      }
      const indexedIds = await tsExportIds(
        context.credentials,
        run.searchIndex.alias,
      );
      const missingIds = indexedIds.filter((id) => !sourceIds.has(id));
      await prisma.$transaction([
        prisma.reconciliationPreview.update({
          where: { id: cursor.reconciliationId },
          data: {
            missingIds,
            sourceCount: sourceIds.size,
            indexedCount: indexedIds.length,
            complete: true,
            failureReason: null,
          },
        }),
        prisma.ingestionRun.update({
          where: { id: run.id },
          data: {
            status: 'SUCCEEDED',
            scanned: sourceIds.size,
            finishedAt: new Date(),
          },
        }),
      ]);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async reconcileExecute(run: LoadedRun) {
    const context = this.context(run);
    const cursor = run.cursor as { reconciliationId?: string };
    if (!cursor.reconciliationId)
      throw new Error('Reconciliation preview is missing');
    const preview = await prisma.reconciliationPreview.findUnique({
      where: { id: cursor.reconciliationId },
    });
    if (
      !preview?.complete ||
      preview.failureReason ||
      preview.expiresAt <= new Date()
    ) {
      throw new Error('Reconciliation preview is not executable');
    }
    const ids = preview.missingIds as string[];
    let deleted = 0;
    for (const id of ids) {
      await tsDeleteDocument(context.credentials, run.searchIndex.alias, id);
      deleted += 1;
    }
    await prisma.$transaction([
      prisma.syncCursor.update({
        where: { searchIndexId: run.searchIndexId },
        data: { lastReconcileAt: new Date() },
      }),
      prisma.ingestionRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          scanned: ids.length,
          deleted,
          finishedAt: new Date(),
        },
      }),
    ]);
  }

  private context(run: LoadedRun) {
    const dataset = run.searchIndex.sourceDataset;
    const connection = run.searchIndex.project.typesenseConnection;
    if (
      run.source.type !== 'POSTGRES' ||
      !run.source.encryptedConfig ||
      !dataset ||
      !connection
    ) {
      throw new Error('PostgreSQL synchronization is not fully configured');
    }
    return {
      dataset,
      stored: JSON.parse(
        decryptSecret(run.source.encryptedConfig, 'postgres-config'),
      ) as StoredPostgresConfig,
      credentials: {
        endpoint: connection.endpoint,
        apiKey: decryptSecret(connection.encryptedApiKey, 'typesense-api-key'),
      },
      mapping: run.searchIndex.mapping as unknown as {
        fields: IndexField[];
        defaultSortingField?: string;
      },
    };
  }

  private async connect(stored: StoredPostgresConfig) {
    const client = new Client({
      connectionString: stored.connectionUrl,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      query_timeout: 15_000,
      ssl: stored.tlsPolicy === 'STRICT' ? { rejectUnauthorized: true } : false,
    });
    await client.connect();
    await client.query('SET default_transaction_read_only = on');
    return client;
  }

  private async assertSchema(
    client: Client,
    dataset: LoadedRun['searchIndex']['sourceDataset'],
  ) {
    if (!dataset) throw new SchemaDriftError();
    const result = await client.query<{
      column_name: string;
      data_type: string;
    }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [dataset.schemaName, dataset.tableName],
    );
    const current = new Map(
      result.rows.map((row) => [row.column_name, row.data_type]),
    );
    const expected = dataset.columnTypes as Record<string, string>;
    for (const [field, type] of Object.entries(expected)) {
      if (current.get(field) !== type) throw new SchemaDriftError();
    }
  }

  private changePage(
    client: Client,
    dataset: NonNullable<LoadedRun['searchIndex']['sourceDataset']>,
    changedAt: Date,
    key: string,
    highWatermark: Date,
  ) {
    const fields = this.selectFields(dataset);
    const table = `${quote(dataset.schemaName)}.${quote(dataset.tableName)}`;
    return client
      .query<Record<string, unknown>>(
        `SELECT ${fields} FROM ${table}
         WHERE (${quote(dataset.updatedAtField)} > $1 OR (${quote(dataset.updatedAtField)} = $1 AND ${quote(dataset.primaryKeyField)}::text > $2))
           AND ${quote(dataset.updatedAtField)} <= $3
         ORDER BY ${quote(dataset.updatedAtField)}, ${quote(dataset.primaryKeyField)}::text
         LIMIT $4`,
        [changedAt, key, highWatermark, config.INGEST_BATCH_DOCUMENTS],
      )
      .then((result) => result.rows);
  }

  private snapshotPage(
    client: Client,
    dataset: NonNullable<LoadedRun['searchIndex']['sourceDataset']>,
    key: string,
  ) {
    const table = `${quote(dataset.schemaName)}.${quote(dataset.tableName)}`;
    return client
      .query<Record<string, unknown>>(
        `SELECT ${this.selectFields(dataset)} FROM ${table}
         WHERE ${quote(dataset.primaryKeyField)}::text > $1
         ORDER BY ${quote(dataset.primaryKeyField)}::text LIMIT $2`,
        [key, config.INGEST_BATCH_DOCUMENTS],
      )
      .then((result) => result.rows);
  }

  private idPage(
    client: Client,
    dataset: NonNullable<LoadedRun['searchIndex']['sourceDataset']>,
    key: string,
  ) {
    const table = `${quote(dataset.schemaName)}.${quote(dataset.tableName)}`;
    const deleted = dataset.deletedAtField
      ? `, ${quote(dataset.deletedAtField)} AS "__osc_deleted"`
      : '';
    return client
      .query<Record<string, unknown>>(
        `SELECT ${quote(dataset.primaryKeyField)}::text AS "__osc_pk"${deleted}
         FROM ${table} WHERE ${quote(dataset.primaryKeyField)}::text > $1
         ORDER BY ${quote(dataset.primaryKeyField)}::text LIMIT $2`,
        [key, config.INGEST_BATCH_DOCUMENTS],
      )
      .then((result) => result.rows);
  }

  private selectFields(
    dataset: NonNullable<LoadedRun['searchIndex']['sourceDataset']>,
  ) {
    const allowlist = dataset.fieldAllowlist as string[];
    const base = allowlist.map(quote).join(', ');
    const deleted = dataset.deletedAtField
      ? `, ${quote(dataset.deletedAtField)} AS "__osc_deleted"`
      : '';
    return `${base}, ${quote(dataset.primaryKeyField)}::text AS "__osc_pk", ${quote(dataset.updatedAtField)} AS "__osc_updated"${deleted}`;
  }

  private document(
    row: Record<string, unknown>,
    key: string,
    fields: IndexField[],
  ) {
    const document: Record<string, unknown> = { id: key };
    for (const field of fields) {
      if (row[field.name] !== undefined && row[field.name] !== null)
        document[field.name] = row[field.name];
    }
    return document;
  }

  private async checkCancelled(runId: string) {
    const state = await prisma.ingestionRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (state?.status === 'CANCEL_REQUESTED') {
      await prisma.ingestionRun.update({
        where: { id: runId },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      throw new CancelledError();
    }
  }
}

class SchemaDriftError extends Error {}
class CancelledError extends Error {}

function loadRun(runId: string) {
  return prisma.ingestionRun.findUnique({
    where: { id: runId },
    include: {
      generation: true,
      source: true,
      searchIndex: {
        include: {
          sourceDataset: true,
          syncCursor: true,
          project: { include: { typesenseConnection: true } },
        },
      },
    },
  });
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function decryptSecret(envelope: string, purpose: string): string {
  return decryptEnvelope(
    purpose,
    envelope,
    config.APP_ENCRYPTION_KEY,
    config.APP_ENCRYPTION_KEY_PREVIOUS,
  ).toString('utf8');
}

async function tsRequest(
  credentials: { endpoint: string; apiKey: string },
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(new URL(path, `${credentials.endpoint}/`), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-typesense-api-key': credentials.apiKey,
      ...init.headers,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(config.TYPESENSE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Typesense request failed (${response.status})`);
  return response.text();
}

async function tsImport(
  credentials: { endpoint: string; apiKey: string },
  collection: string,
  documents: Array<Record<string, unknown>>,
) {
  const text = await tsRequest(
    credentials,
    `/collections/${encodeURIComponent(collection)}/documents/import?action=upsert`,
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: documents.map((document) => JSON.stringify(document)).join('\n'),
    },
  );
  const lines = text.trim().split('\n').filter(Boolean);
  let succeeded = 0;
  let failed = Math.max(0, documents.length - lines.length);
  for (const line of lines) {
    try {
      if ((JSON.parse(line) as { success?: boolean }).success) succeeded += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { succeeded, failed };
}

async function tsDeleteCollection(
  credentials: { endpoint: string; apiKey: string },
  collection: string,
) {
  const response = await fetch(
    new URL(
      `/collections/${encodeURIComponent(collection)}`,
      `${credentials.endpoint}/`,
    ),
    {
      method: 'DELETE',
      headers: { 'x-typesense-api-key': credentials.apiKey },
      signal: AbortSignal.timeout(config.TYPESENSE_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`Typesense delete failed (${response.status})`);
}

async function tsDeleteDocument(
  credentials: { endpoint: string; apiKey: string },
  collection: string,
  id: string,
) {
  const response = await fetch(
    new URL(
      `/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
      `${credentials.endpoint}/`,
    ),
    {
      method: 'DELETE',
      headers: { 'x-typesense-api-key': credentials.apiKey },
      signal: AbortSignal.timeout(config.TYPESENSE_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`Typesense document delete failed (${response.status})`);
}

async function tsExportIds(
  credentials: { endpoint: string; apiKey: string },
  collection: string,
) {
  const text = await tsRequest(
    credentials,
    `/collections/${encodeURIComponent(collection)}/documents/export?include_fields=id`,
  );
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { id: unknown }).id));
}
