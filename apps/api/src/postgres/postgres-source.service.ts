import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ConfigurePostgresSourceRequest,
  CreatePostgresSourceRequest,
  PostgresPreviewRequest,
  WorkspaceRole,
} from '@osc/contracts';
import type { PrismaClient } from '@osc/db';
import {
  composeProjectionDocuments,
  compileRelationFetchQuery,
  stableJson,
  type ProjectionConfig,
} from '@osc/ingestion';
import { Client, type ClientConfig } from 'pg';

import { APP_CONFIG, type AppConfig } from '../app-config.js';
import { PRISMA } from '../infrastructure/tokens.js';
import { EncryptionService } from '../typesense/encryption.service.js';
import { requireWorkspaceRole } from '../workspaces/access.js';
import { validatePostgresUrl } from './postgres-policy.js';

interface StoredPostgresConfig {
  connectionUrl: string;
  tlsPolicy: 'STRICT' | 'ALLOW_INSECURE';
}

interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

interface CatalogForeignKeyRow {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
  ordinal_position: number;
}

interface CatalogIndexRow {
  table_schema: string;
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  column_name: string;
  ordinal_position: number;
}

@Injectable()
export class PostgresSourceService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EncryptionService) private readonly encryption: EncryptionService,
  ) {}

  async create(
    userId: string,
    projectId: string,
    input: CreatePostgresSourceRequest,
  ) {
    const project = await this.project(userId, projectId, 'EDITOR');
    const connectionUrl = await validatePostgresUrl(
      input.connectionUrl,
      input.tlsPolicy,
      this.config,
    );
    const stored: StoredPostgresConfig = {
      connectionUrl,
      tlsPolicy: input.tlsPolicy,
    };
    await this.withClient(stored, async (client) =>
      this.assertReadOnly(client),
    );
    const source = await this.prisma.dataSource.create({
      data: {
        projectId,
        createdById: userId,
        name: input.name,
        type: 'POSTGRES',
        encryptedConfig: this.encryption.encryptFor(
          'postgres-config',
          JSON.stringify(stored),
        ),
        lastTestedAt: new Date(),
      },
      select: this.publicSelect(),
    });
    await this.prisma.auditLog.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        actorId: userId,
        action: 'postgres_source.created',
        targetType: 'data_source',
        targetId: source.id,
        metadata: { tlsPolicy: input.tlsPolicy },
      },
    });
    return source;
  }

  async list(userId: string, projectId: string) {
    await this.project(userId, projectId);
    return {
      data: await this.prisma.dataSource.findMany({
        where: { projectId },
        select: {
          ...this.publicSelect(),
          datasets: true,
          searchIndexes: {
            select: {
              id: true,
              name: true,
              scheduledSync: true,
              syncCursor: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      meta: {},
    };
  }

  async test(userId: string, sourceId: string) {
    const source = await this.source(userId, sourceId, 'EDITOR');
    const result = await this.withClient(
      this.decrypt(source),
      async (client) => {
        await this.assertReadOnly(client);
        const response = await client.query<{ version: string }>(
          'SELECT current_setting($1) AS version',
          ['server_version'],
        );
        return response.rows[0]?.version ?? 'unknown';
      },
    );
    await this.prisma.dataSource.update({
      where: { id: sourceId },
      data: { state: 'READY', lastTestedAt: new Date(), lastError: null },
    });
    return { ok: true, serverVersion: result };
  }

  async datasets(userId: string, sourceId: string) {
    const source = await this.source(userId, sourceId);
    const data = await this.withClient(this.decrypt(source), async (client) => {
      await this.assertReadOnly(client);
      const result = await client.query<{
        schema_name: string;
        table_name: string;
        table_type: string;
      }>(
        `SELECT t.table_schema AS schema_name, t.table_name, t.table_type
         FROM information_schema.tables t
         WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
           AND has_table_privilege(format('%I.%I', t.table_schema, t.table_name), 'SELECT')
         ORDER BY t.table_schema, t.table_name
         LIMIT 200`,
      );
      const columns = await client.query<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name, ordinal_position
         LIMIT 5000`,
      );
      const foreignKeys = await client.query<CatalogForeignKeyRow>(
        `SELECT source_ns.nspname AS table_schema,
                source.relname AS table_name,
                constraint_row.conname AS constraint_name,
                source_attr.attname AS column_name,
                target_ns.nspname AS referenced_schema,
                target.relname AS referenced_table,
                target_attr.attname AS referenced_column,
                key.ordinality AS ordinal_position
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class source ON source.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
         JOIN pg_catalog.pg_class target ON target.oid = constraint_row.confrelid
         JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
         CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
           WITH ORDINALITY AS key(source_attnum, target_attnum, ordinality)
         JOIN pg_catalog.pg_attribute source_attr
           ON source_attr.attrelid = source.oid AND source_attr.attnum = key.source_attnum
         JOIN pg_catalog.pg_attribute target_attr
           ON target_attr.attrelid = target.oid AND target_attr.attnum = key.target_attnum
         WHERE constraint_row.contype = 'f'
           AND source_ns.nspname NOT IN ('pg_catalog', 'information_schema')
           AND has_table_privilege(source.oid, 'SELECT')
           AND has_table_privilege(target.oid, 'SELECT')
         ORDER BY source_ns.nspname, source.relname, constraint_row.conname, key.ordinality
         LIMIT 10000`,
      );
      const indexes = await client.query<CatalogIndexRow>(
        `SELECT ns.nspname AS table_schema, tbl.relname AS table_name,
                idx.relname AS index_name, i.indisunique AS is_unique,
                i.indisprimary AS is_primary,
                attr.attname AS column_name, key.ordinality AS ordinal_position
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
         JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
         JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
         JOIN pg_catalog.pg_attribute attr
           ON attr.attrelid = tbl.oid AND attr.attnum = key.attnum
         WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
           AND i.indisvalid
           AND key.ordinality <= i.indnkeyatts
           AND i.indexprs IS NULL
           AND i.indpred IS NULL
           AND has_table_privilege(tbl.oid, 'SELECT')
         ORDER BY ns.nspname, tbl.relname, idx.relname, key.ordinality
         LIMIT 10000`,
      );
      return result.rows.map((row) => ({
        schemaName: row.schema_name,
        tableName: row.table_name,
        kind: row.table_type,
        columns: columns.rows
          .filter(
            (column) =>
              column.table_schema === row.schema_name &&
              column.table_name === row.table_name,
          )
          .map((column) => ({
            name: column.column_name,
            dataType: column.data_type,
            nullable: column.is_nullable === 'YES',
          })),
        primaryKey:
          groupCatalogRows(
            indexes.rows.filter(
              (index) =>
                index.table_schema === row.schema_name &&
                index.table_name === row.table_name &&
                index.is_primary,
            ),
            (index) => index.index_name,
          )[0]?.map((index) => index.column_name) ?? [],
        uniqueKeys: groupCatalogRows(
          indexes.rows.filter(
            (index) =>
              index.table_schema === row.schema_name &&
              index.table_name === row.table_name &&
              index.is_unique &&
              !index.is_primary,
          ),
          (index) => index.index_name,
        ).map((index) => index.map((item) => item.column_name)),
        foreignKeys: groupCatalogRows(
          foreignKeys.rows.filter(
            (key) =>
              key.table_schema === row.schema_name &&
              key.table_name === row.table_name,
          ),
          (key) => key.constraint_name,
        ).map((key) => ({
          columns: key.map((item) => item.column_name),
          referencedSchema: key[0]!.referenced_schema,
          referencedTable: key[0]!.referenced_table,
          referencedColumns: key.map((item) => item.referenced_column),
        })),
        indexes: groupCatalogRows(
          indexes.rows.filter(
            (index) =>
              index.table_schema === row.schema_name &&
              index.table_name === row.table_name,
          ),
          (index) => index.index_name,
        ).map((index) => ({
          name: index[0]!.index_name,
          unique: index[0]!.is_unique,
          columns: index.map((item) => item.column_name),
        })),
      }));
    });
    return { data, meta: {} };
  }

  async preview(
    userId: string,
    sourceId: string,
    input: PostgresPreviewRequest,
  ) {
    const source = await this.source(userId, sourceId);
    return this.withClient(this.decrypt(source), async (client) => {
      await this.assertReadOnly(client);
      const columns = await this.columns(
        client,
        input.schemaName,
        input.tableName,
      );
      this.assertFields(columns, [...input.fields, input.primaryKeyField]);
      const identifiers = input.fields.map(quote).join(', ');
      const table = `${quote(input.schemaName)}.${quote(input.tableName)}`;
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${identifiers} FROM ${table} ORDER BY ${quote(input.primaryKeyField)} LIMIT $1`,
        [20],
      );
      return { columns, rows: result.rows };
    });
  }

  async previewProjection(
    userId: string,
    sourceId: string,
    config: ProjectionConfig,
    limit: number,
  ) {
    const source = await this.source(userId, sourceId, 'EDITOR');
    return this.withClient(this.decrypt(source), async (client) => {
      await this.assertReadOnly(client);
      await client.query('BEGIN TRANSACTION READ ONLY');
      try {
        await client.query(
          `SET LOCAL statement_timeout = '${config.limits.queryTimeoutMs}ms'`,
        );

        const rootColumns = projectionColumns(config, 'root');
        for (const relation of config.relations) {
          if (relation.from.relation === 'root') {
            relation.from.columns.forEach((column) => rootColumns.add(column));
          }
        }
        config.root.pk.forEach((column) => rootColumns.add(column));
        const rootTable = `${quote(config.root.schema)}.${quote(config.root.table)}`;
        const rootOrder = config.root.pk.map(quote).join(', ');
        const eligibility = config.root.eligibility
          ? ` WHERE ${quote(config.root.eligibility.deletedAtIsNull)} IS NULL`
          : '';
        const roots = await client.query<Record<string, unknown>>(
          `SELECT ${[...rootColumns].map(quote).join(', ')} FROM ${rootTable}${eligibility} ORDER BY ${rootOrder} LIMIT $1`,
          [limit],
        );
        const rootIds = roots.rows.map((row) =>
          stableJson(config.root.pk.map((column) => row[column])),
        );
        const rowsByRelation = new Map<
          string,
          Map<string, Array<Record<string, unknown>>>
        >([
          [
            'root',
            new Map(
              roots.rows.map((row, index) => [
                rootIds[index]!,
                [row] as Array<Record<string, unknown>>,
              ]),
            ),
          ],
        ]);

        for (const relation of config.relations) {
          const parentRows = rowsByRelation.get(relation.from.relation);
          if (!parentRows) {
            throw new BadRequestException('INVALID_RELATION');
          }
          const rootsByJoinKey = new Map<string, Set<string>>();
          const joinKeysByHash = new Map<string, unknown[]>();
          for (const [rootId, rows] of parentRows) {
            for (const row of rows) {
              const key = relation.from.columns.map((column) => row[column]);
              if (key.some((value) => value === null || value === undefined)) {
                continue;
              }
              const hash = stableJson(key);
              joinKeysByHash.set(hash, key);
              const owners = rootsByJoinKey.get(hash) ?? new Set<string>();
              owners.add(rootId);
              rootsByJoinKey.set(hash, owners);
            }
          }
          const targetByRoot = new Map<string, Array<Record<string, unknown>>>(
            rootIds.map((rootId) => [rootId, []]),
          );
          const selectedColumns = projectionColumns(config, relation.id);
          for (const child of config.relations) {
            if (child.from.relation === relation.id) {
              child.from.columns.forEach((column) =>
                selectedColumns.add(column),
              );
            }
          }
          const keys = [...joinKeysByHash.values()];
          for (let offset = 0; offset < keys.length; offset += 100) {
            const batch = keys.slice(offset, offset + 100);
            const query = compileRelationFetchQuery(
              relation,
              [...selectedColumns],
              batch,
            );
            const result = await client.query<Record<string, unknown>>(
              query.text,
              [...query.values],
            );
            const queryLimit =
              Math.min(
                relation.limitPerRoot ?? config.limits.maxRowsPerRoot,
                config.limits.maxRowsPerRoot,
              ) * batch.length;
            if (result.rows.length >= queryLimit) {
              throw new BadRequestException('FANOUT_LIMIT');
            }
            for (const row of result.rows) {
              const hash = stableJson(
                relation.to.columns.map((column) => row[column]),
              );
              for (const rootId of rootsByJoinKey.get(hash) ?? []) {
                const target = targetByRoot.get(rootId);
                if (!target) continue;
                target.push(row);
                if (target.length > config.limits.maxRowsPerRoot) {
                  throw new BadRequestException('FANOUT_LIMIT');
                }
              }
            }
          }
          rowsByRelation.set(relation.id, targetByRoot);
        }

        const composition = composeProjectionDocuments(
          config,
          roots.rows,
          rowsByRelation,
        );
        return {
          documents: composition.documents,
          diagnostics: composition.diagnostics,
          sampledRoots: roots.rows.length,
        };
      } finally {
        await client.query('ROLLBACK');
      }
    });
  }

  async configure(
    userId: string,
    sourceId: string,
    input: ConfigurePostgresSourceRequest,
  ) {
    const source = await this.source(userId, sourceId, 'EDITOR');
    const index = await this.prisma.searchIndex.findFirst({
      where: { id: input.searchIndexId, projectId: source.projectId },
    });
    if (!index) throw new NotFoundException('Search index not found');
    const columns = await this.withClient(
      this.decrypt(source),
      async (client) => {
        await this.assertReadOnly(client);
        const discovered = await this.columns(
          client,
          input.schemaName,
          input.tableName,
        );
        this.assertFields(discovered, [
          ...input.fieldAllowlist,
          input.primaryKeyField,
          input.updatedAtField,
          ...(input.deletedAtField ? [input.deletedAtField] : []),
        ]);
        const pk = discovered.find(
          (item) => item.name === input.primaryKeyField,
        );
        const updated = discovered.find(
          (item) => item.name === input.updatedAtField,
        );
        if (!pk || pk.nullable) {
          throw new BadRequestException('Primary key field must be non-null');
        }
        if (!updated || !updated.dataType.includes('timestamp')) {
          throw new BadRequestException(
            'Update cursor field must be a timestamp',
          );
        }
        return discovered;
      },
    );
    const columnTypes = Object.fromEntries(
      columns
        .filter((column) => input.fieldAllowlist.includes(column.name))
        .map((column) => [column.name, column.dataType]),
    );
    const dataset = await this.prisma.$transaction(async (transaction) => {
      const configured = await transaction.sourceDataset.upsert({
        where: {
          dataSourceId_schemaName_tableName: {
            dataSourceId: sourceId,
            schemaName: input.schemaName,
            tableName: input.tableName,
          },
        },
        create: {
          dataSourceId: sourceId,
          schemaName: input.schemaName,
          tableName: input.tableName,
          primaryKeyField: input.primaryKeyField,
          updatedAtField: input.updatedAtField,
          deletedAtField: input.deletedAtField,
          fieldAllowlist: input.fieldAllowlist,
          columnTypes,
        },
        update: {
          primaryKeyField: input.primaryKeyField,
          updatedAtField: input.updatedAtField,
          deletedAtField: input.deletedAtField,
          fieldAllowlist: input.fieldAllowlist,
          columnTypes,
        },
      });
      await transaction.searchIndex.update({
        where: { id: index.id },
        data: { sourceId, sourceDatasetId: configured.id },
      });
      await transaction.syncCursor.upsert({
        where: { searchIndexId: index.id },
        create: { searchIndexId: index.id },
        update: { value: {} },
      });
      await transaction.scheduledSync.upsert({
        where: { searchIndexId: index.id },
        create: {
          searchIndexId: index.id,
          intervalMinutes: input.intervalMinutes,
          nextRunAt: addMinutes(new Date(), input.intervalMinutes),
        },
        update: {
          intervalMinutes: input.intervalMinutes,
          enabled: true,
          nextRunAt: addMinutes(new Date(), input.intervalMinutes),
        },
      });
      return configured;
    });
    return { dataset, schedule: { intervalMinutes: input.intervalMinutes } };
  }

  async remove(userId: string, sourceId: string) {
    const source = await this.source(userId, sourceId, 'EDITOR');
    const active = await this.prisma.ingestionRun.findFirst({
      where: {
        sourceId,
        status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] },
      },
    });
    if (active) {
      throw new BadRequestException(
        'PostgreSQL source cannot be removed while a run is active',
      );
    }
    await this.prisma.dataSource.delete({ where: { id: sourceId } });
    return { deleted: true, sourceId, projectId: source.projectId };
  }

  private async assertReadOnly(client: Client) {
    const role = await client.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      can_write: boolean;
    }>(
      `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole,
        EXISTS (
          SELECT 1 FROM information_schema.tables t
          WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
            AND (has_table_privilege(format('%I.%I', t.table_schema, t.table_name), 'INSERT')
              OR has_table_privilege(format('%I.%I', t.table_schema, t.table_name), 'UPDATE')
              OR has_table_privilege(format('%I.%I', t.table_schema, t.table_name), 'DELETE')
              OR has_table_privilege(format('%I.%I', t.table_schema, t.table_name), 'TRUNCATE'))
        ) AS can_write
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const current = role.rows[0];
    if (
      !current ||
      current.rolsuper ||
      current.rolcreatedb ||
      current.rolcreaterole ||
      current.can_write
    ) {
      throw new BadRequestException(
        'PostgreSQL account must be a non-privileged read-only account',
      );
    }
  }

  private async columns(client: Client, schemaName: string, tableName: string) {
    const result = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position
       LIMIT 200`,
      [schemaName, tableName],
    );
    if (!result.rows.length) throw new NotFoundException('Dataset not found');
    return result.rows.map((row): ColumnInfo => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
    }));
  }

  private assertFields(columns: ColumnInfo[], fields: string[]) {
    const allowed = new Set(columns.map((column) => column.name));
    for (const field of new Set(fields)) {
      if (!allowed.has(field)) {
        throw new BadRequestException(`Column ${field} is not available`);
      }
    }
  }

  private withClient<T>(
    stored: StoredPostgresConfig,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    const options: ClientConfig = {
      connectionString: stored.connectionUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      ssl: stored.tlsPolicy === 'STRICT' ? { rejectUnauthorized: true } : false,
    };
    const client = new Client(options);
    return client
      .connect()
      .then(async () => {
        await client.query('BEGIN READ ONLY');
        try {
          const result = await operation(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      })
      .finally(() => client.end().catch(() => undefined));
  }

  private decrypt(source: { encryptedConfig: string | null }) {
    if (!source.encryptedConfig) {
      throw new BadRequestException('PostgreSQL source is not configured');
    }
    return JSON.parse(
      this.encryption.decryptFor('postgres-config', source.encryptedConfig),
    ) as StoredPostgresConfig;
  }

  private publicSelect() {
    return {
      id: true,
      projectId: true,
      name: true,
      type: true,
      state: true,
      lastTestedAt: true,
      lastSyncAt: true,
      errorCount: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    } as const;
  }

  private async source(
    userId: string,
    sourceId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const source = await this.prisma.dataSource.findFirst({
      where: {
        id: sourceId,
        type: 'POSTGRES',
        project: { workspace: { memberships: { some: { userId } } } },
      },
      include: { project: true },
    });
    if (!source) throw new NotFoundException('PostgreSQL source not found');
    await requireWorkspaceRole(
      this.prisma,
      source.project.workspaceId,
      userId,
      role,
    );
    return source;
  }

  private async project(
    userId: string,
    projectId: string,
    role: WorkspaceRole = 'VIEWER',
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        workspace: { memberships: { some: { userId } } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    await requireWorkspaceRole(this.prisma, project.workspaceId, userId, role);
    return project;
  }
}

function groupCatalogRows<T>(rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return [...groups.values()];
}

function projectionColumns(
  config: ProjectionConfig,
  relationId: string,
): Set<string> {
  const selected = new Set<string>();
  for (const field of config.fields) {
    for (const path of [
      field.path,
      ...(field.concatPaths ?? []),
      ...(field.orderBy ?? []).map((order) => order.path),
    ]) {
      const [pathRelation, column] = splitProjectionPath(path);
      if (pathRelation === relationId) selected.add(column);
    }
  }
  return selected;
}

function splitProjectionPath(path: string): [string, string] {
  const separator = path.indexOf('.');
  if (separator < 1 || separator === path.length - 1) {
    throw new BadRequestException('INVALID_COLUMN');
  }
  return [path.slice(0, separator), path.slice(separator + 1)];
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}
