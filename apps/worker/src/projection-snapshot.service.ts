import { Injectable, Logger } from '@nestjs/common';
import { workerEnvironmentSchema, type IndexField } from '@osc/contracts';
import { createPrismaClient } from '@osc/db';
import {
  compileRelationFetchQuery,
  composeProjectionDocuments,
  decryptEnvelope,
  decodeCanonicalKey,
  encodeCanonicalKey,
  encryptEnvelope,
  projectionConfigHash,
  projectionConfigSchema,
  projectionDependencyKeys,
  projectionSchemaFingerprint,
  protectedKeyHmac,
  stableJson,
  type CatalogRelation,
  type ProjectionConfig,
} from '@osc/ingestion';
import { Client, type ClientConfig } from 'pg';
import { createHash } from 'node:crypto';

const config = workerEnvironmentSchema.parse(process.env);
const prisma = createPrismaClient(config.DATABASE_URL);

async function loadGeneration(id: string) {
  return prisma.projectionGeneration.findUnique({
    where: { id },
    include: {
      projectionVersion: true,
      projection: { include: { source: true } },
      indexGeneration: {
        include: {
          searchIndex: {
            include: {
              project: { include: { typesenseConnection: true } },
            },
          },
        },
      },
    },
  });
}

type LoadedGeneration = NonNullable<Awaited<ReturnType<typeof loadGeneration>>>;

interface StoredPostgresConfig {
  connectionUrl: string;
  tlsPolicy: 'STRICT' | 'ALLOW_INSECURE';
}

interface SnapshotCounters {
  scanned: number;
  imported: number;
  failed: number;
  eventualConsistencyAccepted?: boolean;
}

interface SnapshotCheckpoint {
  initialized?: boolean;
  lastKey?: string | number | boolean | null;
  manifestHash?: string;
}

@Injectable()
export class ProjectionSnapshotService {
  private readonly logger = new Logger(ProjectionSnapshotService.name);

  async process(
    projectionGenerationId: string,
    expectedFence: string,
    finalAttempt: boolean,
  ): Promise<void> {
    if (!config.ENABLE_RELATIONAL_PROJECTIONS) return;
    const generation = await loadGeneration(projectionGenerationId);
    if (!generation) return;
    if (generation.fencingToken.toString() !== expectedFence) return;
    if (
      !['QUEUED', 'RUNNING', 'READY_TO_PROMOTE', 'PROMOTING'].includes(
        generation.status,
      )
    )
      return;

    if (['QUEUED', 'RUNNING'].includes(generation.status)) {
      const claimed = await prisma.projectionGeneration.updateMany({
        where: {
          id: generation.id,
          fencingToken: generation.fencingToken,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        data: {
          status: 'RUNNING',
          startedAt: generation.startedAt ?? new Date(),
        },
      });
      if (!claimed.count) return;
    }

    const sourceConfig = this.decryptPostgres(
      generation.projection.source.encryptedConfig,
    );
    const connection =
      generation.indexGeneration.searchIndex.project.typesenseConnection;
    if (!connection) throw new Error('TYPESENSE_UNAVAILABLE');
    const credentials = {
      endpoint: connection.endpoint,
      apiKey: this.decryptSecret(connection.encryptedApiKey),
    };
    const projectionConfig = projectionConfigSchema.parse(
      generation.projectionVersion.config,
    );
    const mapping = generation.indexGeneration.searchIndex
      .mapping as unknown as {
      fields: IndexField[];
      defaultSortingField?: string;
    };
    const collection = generation.indexGeneration.physicalCollection;
    const checkpoint = generation.rootCheckpoint as SnapshotCheckpoint;
    const counters = generation.counters as unknown as SnapshotCounters;
    const client = await this.connect(sourceConfig);
    let promotionStarted = false;

    try {
      await this.assertVersionAndSchema(
        client,
        generation.projectionVersion.configHash,
        generation.projectionVersion.schemaFingerprint,
        projectionConfig,
      );
      if (['READY_TO_PROMOTE', 'PROMOTING'].includes(generation.status)) {
        promotionStarted = true;
        await this.promote(generation, credentials, counters);
        return;
      }
      if (!checkpoint.initialized) {
        await tsDelete(
          credentials,
          `/collections/${encodeURIComponent(collection)}`,
        );
        await tsRequest(credentials, '/collections', {
          method: 'POST',
          body: JSON.stringify({
            name: collection,
            fields: mapping.fields.map((field) => ({
              name: field.name,
              type: field.type,
              facet: field.facet,
              optional: field.optional,
              sort: field.sort,
              index: field.searchable || field.facet || field.sort,
            })),
            ...(mapping.defaultSortingField
              ? { default_sorting_field: mapping.defaultSortingField }
              : {}),
          }),
        });
        checkpoint.initialized = true;
        checkpoint.manifestHash = createHash('sha256')
          .update('osc:projection-manifest:v1')
          .digest('hex');
        await prisma.projectionError.deleteMany({
          where: { projectionGenerationId: generation.id },
        });
      }

      while (true) {
        await this.assertFence(generation.id, generation.fencingToken);
        await client.query(
          'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        let roots: Array<Record<string, unknown>>;
        let rowsByRelation: Map<
          string,
          Map<string, Array<Record<string, unknown>>>
        >;
        try {
          await client.query(
            `SET LOCAL statement_timeout = '${projectionConfig.limits.queryTimeoutMs}ms'`,
          );
          roots = await this.rootPage(
            client,
            projectionConfig,
            checkpoint.lastKey,
          );
          rowsByRelation = roots.length
            ? await this.relationRows(client, projectionConfig, roots)
            : new Map();
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
        if (!roots.length) break;
        const composition = composeProjectionDocuments(
          projectionConfig,
          roots,
          rowsByRelation,
        );
        const importResults = composition.documents.length
          ? await tsImport(credentials, collection, composition.documents)
          : [];
        const importErrors: Array<{
          documentId: string;
          code: string;
        }> = [];
        importResults.forEach((result, index) => {
          if (!result.success) {
            importErrors.push({
              documentId: String(composition.documents[index]?.id ?? 'unknown'),
              code: 'INDEX_PARTIAL_FAILURE',
            });
          }
        });
        const failedIds = new Set(importErrors.map((item) => item.documentId));
        const importedStates = composition.states.filter(
          (state) =>
            state.terminalState === 'COMPOSED' &&
            !failedIds.has(state.documentId),
        );
        const pageFailed = composition.diagnostics.length + importErrors.length;
        counters.scanned += roots.length;
        counters.imported += importedStates.length;
        counters.failed += pageFailed;
        checkpoint.lastKey = roots.at(-1)?.[projectionConfig.root.pk[0]!] as
          string | number | boolean | null;
        for (const state of importedStates) {
          checkpoint.manifestHash = createHash('sha256')
            .update(checkpoint.manifestHash ?? '')
            .update('\n')
            .update(state.documentId)
            .update(':')
            .update(state.canonicalHash ?? '')
            .digest('hex');
        }
        const hmacKey = Buffer.from(
          config.APP_HMAC_KEY ?? config.APP_ENCRYPTION_KEY,
          'base64',
        );
        await prisma.$transaction(async (transaction) => {
          for (const state of composition.states) {
            const imported =
              state.terminalState === 'COMPOSED' &&
              !failedIds.has(state.documentId);
            const rootKeyHmac = protectedKeyHmac(state.rootKeyParts, hmacKey);
            const rootKeyCiphertext = this.encryptRootKey(state.rootKeyParts);
            await transaction.projectionDocumentState.upsert({
              where: {
                projectionId_projectionVersionId_rootKeyHmac: {
                  projectionId: generation.projectionId,
                  projectionVersionId: generation.projectionVersionId,
                  rootKeyHmac,
                },
              },
              create: {
                projectionId: generation.projectionId,
                projectionVersionId: generation.projectionVersionId,
                rootKeyHmac,
                rootKeyCiphertext,
                documentId: state.documentId,
                canonicalHash:
                  state.canonicalHash ??
                  createHash('sha256').update('failed').digest('hex'),
                activeGenerationId: imported ? generation.id : null,
                terminalState: imported ? 'IMPORTED' : 'FAILED',
              },
              update: {
                canonicalHash:
                  state.canonicalHash ??
                  createHash('sha256').update('failed').digest('hex'),
                activeGenerationId: imported ? generation.id : null,
                terminalState: imported ? 'IMPORTED' : 'FAILED',
              },
            });
            if (imported) {
              await transaction.projectionDependencyEdge.updateMany({
                where: {
                  projectionId: generation.projectionId,
                  projectionVersionId: generation.projectionVersionId,
                  rootKeyHmac,
                  removedAt: null,
                },
                data: {
                  removedAt: new Date(),
                  retainUntil: new Date(Date.now() + 30 * 24 * 60 * 60_000),
                },
              });
              for (const dependency of projectionDependencyKeys(
                projectionConfig,
                rowsByRelation,
                state.rootKeyHash,
              )) {
                const relatedKeyHmac = protectedKeyHmac(
                  dependency.keyParts,
                  hmacKey,
                );
                await transaction.projectionDependencyEdge.upsert({
                  where: {
                    projectionId_projectionVersionId_relationId_relatedKeyHmac_rootKeyHmac:
                      {
                        projectionId: generation.projectionId,
                        projectionVersionId: generation.projectionVersionId,
                        relationId: dependency.relationId,
                        relatedKeyHmac,
                        rootKeyHmac,
                      },
                  },
                  create: {
                    projectionId: generation.projectionId,
                    projectionVersionId: generation.projectionVersionId,
                    relationId: dependency.relationId,
                    relatedKeyHmac,
                    rootKeyHmac,
                    rootKeyCiphertext,
                    firstSeenGeneration: generation.indexGeneration.generation,
                    lastSeenGeneration: generation.indexGeneration.generation,
                  },
                  update: {
                    rootKeyCiphertext,
                    lastSeenGeneration: generation.indexGeneration.generation,
                    removedAt: null,
                    retainUntil: null,
                  },
                });
              }
            }
          }
          for (const diagnostic of composition.diagnostics) {
            await transaction.projectionError.create({
              data: {
                projectionId: generation.projectionId,
                projectionVersionId: generation.projectionVersionId,
                projectionGenerationId: generation.id,
                code: diagnostic.code,
                sanitizedMessage: diagnostic.message,
                entityHmac: createHash('sha256')
                  .update(diagnostic.root)
                  .digest('hex'),
              },
            });
          }
          for (const failure of importErrors) {
            await transaction.projectionError.create({
              data: {
                projectionId: generation.projectionId,
                projectionVersionId: generation.projectionVersionId,
                projectionGenerationId: generation.id,
                code: failure.code,
                sanitizedMessage: 'Typesense rejected a projected document',
                entityHmac: createHash('sha256')
                  .update(failure.documentId)
                  .digest('hex'),
              },
            });
          }
          await transaction.projectionGeneration.update({
            where: { id: generation.id },
            data: {
              rootCheckpoint: JSON.parse(JSON.stringify(checkpoint)),
              counters: JSON.parse(JSON.stringify(counters)),
              manifestHash: checkpoint.manifestHash,
            },
          });
          await transaction.indexGeneration.update({
            where: { id: generation.indexGenerationId },
            data: { recordCount: counters.imported },
          });
        });
        if (roots.length < projectionConfig.limits.batchRoots) break;
      }

      if (
        counters.failed > 0 ||
        counters.imported + counters.failed !== counters.scanned
      ) {
        throw new SnapshotError('INDEX_PARTIAL_FAILURE');
      }
      await this.assertVersionAndSchema(
        client,
        generation.projectionVersion.configHash,
        generation.projectionVersion.schemaFingerprint,
        projectionConfig,
      );
      const ready = await prisma.projectionGeneration.updateMany({
        where: {
          id: generation.id,
          fencingToken: generation.fencingToken,
          status: 'RUNNING',
        },
        data: {
          status: 'READY_TO_PROMOTE',
          rootCheckpoint: JSON.parse(JSON.stringify(checkpoint)),
          counters: JSON.parse(JSON.stringify(counters)),
          manifestHash: checkpoint.manifestHash,
        },
      });
      if (!ready.count) throw new SnapshotError('STALE_GENERATION');
      promotionStarted = true;
      await this.promote(generation, credentials, counters);
    } catch (error) {
      const code =
        error instanceof SnapshotError ? error.message : 'SNAPSHOT_FAILED';
      const retryable =
        !(error instanceof SnapshotError) || error.retryable === true;
      if (!promotionStarted) {
        if (retryable && !finalAttempt) {
          await prisma.projectionGeneration.updateMany({
            where: {
              id: generation.id,
              fencingToken: generation.fencingToken,
              status: 'RUNNING',
            },
            data: { errorCode: code },
          });
          throw error;
        }
        await tsDelete(
          credentials,
          `/collections/${encodeURIComponent(collection)}`,
        ).catch(() => undefined);
        await prisma.$transaction([
          prisma.projectionGeneration.updateMany({
            where: {
              id: generation.id,
              fencingToken: generation.fencingToken,
              status: { in: ['QUEUED', 'RUNNING', 'READY_TO_PROMOTE'] },
            },
            data: {
              status: 'FAILED',
              errorCode: code,
              completedAt: new Date(),
            },
          }),
          prisma.indexGeneration.update({
            where: { id: generation.indexGenerationId },
            data: { state: 'FAILED', recordCount: counters.imported },
          }),
        ]);
      } else if (finalAttempt) {
        const failed = await prisma.projectionGeneration.updateMany({
          where: {
            id: generation.id,
            fencingToken: generation.fencingToken,
            status: 'READY_TO_PROMOTE',
          },
          data: {
            status: 'FAILED',
            errorCode: code,
            completedAt: new Date(),
          },
        });
        if (failed.count) {
          await tsDelete(
            credentials,
            `/collections/${encodeURIComponent(collection)}`,
          ).catch(() => undefined);
          await prisma.indexGeneration.update({
            where: { id: generation.indexGenerationId },
            data: { state: 'FAILED', recordCount: counters.imported },
          });
        }
      }
      this.logger.error(
        `Projection generation ${generation.id} failed: ${code}`,
      );
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async promote(
    generation: LoadedGeneration,
    credentials: { endpoint: string; apiKey: string },
    counters: SnapshotCounters,
  ) {
    const searchIndex = generation.indexGeneration.searchIndex;
    const previous = await prisma.indexGeneration.findFirst({
      where: { searchIndexId: searchIndex.id, state: 'ACTIVE' },
      select: { id: true, physicalCollection: true },
    });
    if (generation.status !== 'PROMOTING') {
      const claimed = await prisma.projectionGeneration.updateMany({
        where: {
          id: generation.id,
          fencingToken: generation.fencingToken,
          status: 'READY_TO_PROMOTE',
        },
        data: { status: 'PROMOTING' },
      });
      if (!claimed.count) throw new SnapshotError('STALE_GENERATION');
      try {
        await tsRequest(
          credentials,
          `/aliases/${encodeURIComponent(searchIndex.alias)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              collection_name: generation.indexGeneration.physicalCollection,
            }),
          },
        );
      } catch (error) {
        await prisma.projectionGeneration.updateMany({
          where: {
            id: generation.id,
            fencingToken: generation.fencingToken,
            status: 'PROMOTING',
          },
          data: {
            status: 'READY_TO_PROMOTE',
            errorCode: 'TYPESENSE_UNAVAILABLE',
          },
        });
        throw error;
      }
    } else {
      const alias = JSON.parse(
        await tsRequest(
          credentials,
          `/aliases/${encodeURIComponent(searchIndex.alias)}`,
        ),
      ) as { collection_name?: string };
      if (
        alias.collection_name !== generation.indexGeneration.physicalCollection
      ) {
        await prisma.projectionGeneration.updateMany({
          where: {
            id: generation.id,
            fencingToken: generation.fencingToken,
            status: 'PROMOTING',
          },
          data: { status: 'READY_TO_PROMOTE' },
        });
        throw new SnapshotError('TYPESENSE_UNAVAILABLE', true);
      }
    }
    try {
      await prisma.$transaction(async (transaction) => {
        const current = await transaction.projectionGeneration.findFirst({
          where: {
            id: generation.id,
            fencingToken: generation.fencingToken,
            status: 'PROMOTING',
          },
          select: { id: true },
        });
        if (!current) throw new SnapshotError('STALE_GENERATION');
        await transaction.indexGeneration.updateMany({
          where: { searchIndexId: searchIndex.id, state: 'ACTIVE' },
          data: { state: 'SUPERSEDED' },
        });
        await transaction.projectionGeneration.updateMany({
          where: { projectionId: generation.projectionId, status: 'ACTIVE' },
          data: { status: 'SUPERSEDED', completedAt: new Date() },
        });
        await transaction.indexGeneration.update({
          where: { id: generation.indexGenerationId },
          data: {
            state: 'ACTIVE',
            recordCount: counters.imported,
            activatedAt: new Date(),
          },
        });
        await transaction.projectionGeneration.update({
          where: { id: generation.id },
          data: { status: 'ACTIVE', completedAt: new Date(), errorCode: null },
        });
        await transaction.sourceProjectionVersion.update({
          where: { id: generation.projectionVersionId },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });
        await transaction.sourceProjection.update({
          where: { id: generation.projectionId },
          data: {
            status: 'PUBLISHED',
            activeVersionId: generation.projectionVersionId,
            draftVersionId: null,
          },
        });
        await transaction.searchIndex.update({
          where: { id: searchIndex.id },
          data: {
            activeGeneration: generation.indexGeneration.generation,
            state: 'READY',
          },
        });
        await transaction.dataSource.update({
          where: { id: generation.projection.sourceId },
          data: { state: 'READY', lastSyncAt: new Date(), lastError: null },
        });
      });
    } catch (error) {
      try {
        if (previous) {
          await tsRequest(
            credentials,
            `/aliases/${encodeURIComponent(searchIndex.alias)}`,
            {
              method: 'PUT',
              body: JSON.stringify({
                collection_name: previous.physicalCollection,
              }),
            },
          );
        } else {
          await tsDelete(
            credentials,
            `/aliases/${encodeURIComponent(searchIndex.alias)}`,
          );
        }
      } catch (rollbackError) {
        await prisma.projectionGeneration.updateMany({
          where: {
            id: generation.id,
            fencingToken: generation.fencingToken,
            status: 'PROMOTING',
          },
          data: { errorCode: 'PROMOTION_RECOVERY_REQUIRED' },
        });
        throw rollbackError;
      }
      await prisma.$transaction([
        prisma.projectionGeneration.update({
          where: { id: generation.id },
          data: {
            status: 'FAILED',
            errorCode: 'PROMOTION_CONTROL_STATE_FAILED',
            completedAt: new Date(),
          },
        }),
        prisma.indexGeneration.update({
          where: { id: generation.indexGenerationId },
          data: { state: 'FAILED', recordCount: counters.imported },
        }),
      ]);
      throw error;
    }
  }

  private async rootPage(
    client: Client,
    projection: ProjectionConfig,
    after: SnapshotCheckpoint['lastKey'],
  ) {
    const columns = projectionColumns(projection, 'root');
    projection.root.pk.forEach((column) => columns.add(column));
    projection.relations
      .filter((relation) => relation.from.relation === 'root')
      .forEach((relation) =>
        relation.from.columns.forEach((column) => columns.add(column)),
      );
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (projection.root.eligibility) {
      conditions.push(
        `${quote(projection.root.eligibility.deletedAtIsNull)} IS NULL`,
      );
    }
    if (after !== undefined) {
      values.push(after);
      conditions.push(`${quote(projection.root.pk[0]!)} > $${values.length}`);
    }
    values.push(projection.limits.batchRoots);
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${[...columns].map(quote).join(', ')} FROM ${quote(projection.root.schema)}.${quote(projection.root.table)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${quote(projection.root.pk[0]!)} ASC LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  }

  async relationRows(
    client: Client,
    projection: ProjectionConfig,
    roots: Array<Record<string, unknown>>,
  ) {
    const rootIds = roots.map((row) =>
      stableJson(projection.root.pk.map((column) => row[column])),
    );
    const rowsByRelation = new Map<
      string,
      Map<string, Array<Record<string, unknown>>>
    >([
      [
        'root',
        new Map(
          roots.map((row, index) => [
            rootIds[index]!,
            [row] as Array<Record<string, unknown>>,
          ]),
        ),
      ],
    ]);
    for (const relation of projection.relations) {
      const parentRows = rowsByRelation.get(relation.from.relation);
      if (!parentRows) throw new SnapshotError('INVALID_RELATION');
      const rootsByJoinKey = new Map<string, Set<string>>();
      const joinKeys = new Map<string, unknown[]>();
      for (const [rootId, rows] of parentRows) {
        for (const row of rows) {
          const key = relation.from.columns.map((column) => row[column]);
          if (key.some((value) => value === null || value === undefined))
            continue;
          const hash = stableJson(key);
          joinKeys.set(hash, key);
          const owners = rootsByJoinKey.get(hash) ?? new Set<string>();
          owners.add(rootId);
          rootsByJoinKey.set(hash, owners);
        }
      }
      const targetByRoot = new Map<string, Array<Record<string, unknown>>>(
        rootIds.map((rootId) => [rootId, []]),
      );
      const selected = projectionColumns(projection, relation.id);
      const trackingColumns =
        relation.changeTracking.mode === 'poll'
          ? relation.changeTracking.key
          : relation.to.columns;
      trackingColumns.forEach((column) => selected.add(column));
      projection.relations
        .filter((child) => child.from.relation === relation.id)
        .forEach((child) =>
          child.from.columns.forEach((column) => selected.add(column)),
        );
      const keys = [...joinKeys.values()];
      for (let offset = 0; offset < keys.length; offset += 100) {
        const query = compileRelationFetchQuery(
          relation,
          [...selected],
          keys.slice(offset, offset + 100),
        );
        const result = await client.query<Record<string, unknown>>(query.text, [
          ...query.values,
        ]);
        for (const row of result.rows) {
          const hash = stableJson(
            relation.to.columns.map((column) => row[column]),
          );
          for (const rootId of rootsByJoinKey.get(hash) ?? []) {
            const target = targetByRoot.get(rootId)!;
            target.push(row);
            if (target.length > projection.limits.maxRowsPerRoot) {
              throw new SnapshotError('FANOUT_LIMIT');
            }
          }
        }
      }
      rowsByRelation.set(relation.id, targetByRoot);
    }
    return rowsByRelation;
  }

  async assertVersionAndSchema(
    client: Client,
    expectedConfigHash: string,
    expectedSchemaFingerprint: string | null,
    projection: ProjectionConfig,
  ) {
    if (
      projectionConfigHash(projection) !== expectedConfigHash ||
      !expectedSchemaFingerprint
    ) {
      throw new SnapshotError('STALE_GENERATION');
    }
    const catalog = await this.catalog(client);
    if (
      projectionSchemaFingerprint(projection, catalog) !==
      expectedSchemaFingerprint
    ) {
      throw new SnapshotError('SCHEMA_DRIFT');
    }
  }

  private async catalog(client: Client): Promise<CatalogRelation[]> {
    const relations = await client.query<{
      schema_name: string;
      table_name: string;
      table_type: string;
    }>(`SELECT table_schema AS schema_name, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND has_table_privilege(format('%I.%I', table_schema, table_name), 'SELECT')
        ORDER BY table_schema, table_name LIMIT 200`);
    const columns = await client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`SELECT table_schema, table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position LIMIT 5000`);
    const indexes = await client.query<{
      table_schema: string;
      table_name: string;
      index_name: string;
      is_unique: boolean;
      is_primary: boolean;
      column_name: string;
    }>(`SELECT ns.nspname AS table_schema, tbl.relname AS table_name,
          idx.relname AS index_name, i.indisunique AS is_unique,
          i.indisprimary AS is_primary, attr.attname AS column_name
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
        JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = key.attnum
        WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND i.indisvalid AND key.ordinality <= i.indnkeyatts
          AND i.indexprs IS NULL AND i.indpred IS NULL
          AND has_table_privilege(tbl.oid, 'SELECT')
        ORDER BY ns.nspname, tbl.relname, idx.relname, key.ordinality LIMIT 10000`);
    const foreignKeys = await client.query<{
      table_schema: string;
      table_name: string;
      constraint_name: string;
      column_name: string;
      referenced_schema: string;
      referenced_table: string;
      referenced_column: string;
    }>(`SELECT source_ns.nspname AS table_schema, source.relname AS table_name,
          c.conname AS constraint_name, source_attr.attname AS column_name,
          target_ns.nspname AS referenced_schema, target.relname AS referenced_table,
          target_attr.attname AS referenced_column
        FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class source ON source.oid = c.conrelid
        JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
        JOIN pg_catalog.pg_class target ON target.oid = c.confrelid
        JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
        CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS key(source_attnum, target_attnum, ordinality)
        JOIN pg_catalog.pg_attribute source_attr ON source_attr.attrelid = source.oid AND source_attr.attnum = key.source_attnum
        JOIN pg_catalog.pg_attribute target_attr ON target_attr.attrelid = target.oid AND target_attr.attnum = key.target_attnum
        WHERE c.contype = 'f' AND source_ns.nspname NOT IN ('pg_catalog', 'information_schema')
          AND has_table_privilege(source.oid, 'SELECT') AND has_table_privilege(target.oid, 'SELECT')
        ORDER BY source_ns.nspname, source.relname, c.conname, key.ordinality LIMIT 10000`);
    return relations.rows.map((relation) => {
      const relationIndexes = groupBy(
        indexes.rows.filter(
          (item) =>
            item.table_schema === relation.schema_name &&
            item.table_name === relation.table_name,
        ),
        (item) => item.index_name,
      );
      return {
        schema: relation.schema_name,
        table: relation.table_name,
        kind: relation.table_type === 'VIEW' ? 'VIEW' : 'BASE TABLE',
        columns: columns.rows
          .filter(
            (item) =>
              item.table_schema === relation.schema_name &&
              item.table_name === relation.table_name,
          )
          .map((item) => ({
            name: item.column_name,
            dataType: item.data_type,
            nullable: item.is_nullable === 'YES',
          })),
        primaryKey:
          relationIndexes
            .find((items) => items[0]?.is_primary)
            ?.map((item) => item.column_name) ?? [],
        uniqueKeys: relationIndexes
          .filter((items) => items[0]?.is_unique && !items[0]?.is_primary)
          .map((items) => items.map((item) => item.column_name)),
        foreignKeys: groupBy(
          foreignKeys.rows.filter(
            (item) =>
              item.table_schema === relation.schema_name &&
              item.table_name === relation.table_name,
          ),
          (item) => item.constraint_name,
        ).map((items) => ({
          columns: items.map((item) => item.column_name),
          referencedSchema: items[0]!.referenced_schema,
          referencedTable: items[0]!.referenced_table,
          referencedColumns: items.map((item) => item.referenced_column),
        })),
      };
    });
  }

  private async assertFence(id: string, token: bigint) {
    const current = await prisma.projectionGeneration.findFirst({
      where: { id, fencingToken: token, status: 'RUNNING' },
      select: { id: true },
    });
    if (!current) throw new SnapshotError('STALE_GENERATION');
  }

  async connect(stored: StoredPostgresConfig) {
    const options: ClientConfig = {
      connectionString: stored.connectionUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 6_000,
      statement_timeout: 5_000,
      application_name: 'open-search-console-projection-snapshot',
    };
    if (stored.tlsPolicy === 'STRICT')
      options.ssl = { rejectUnauthorized: true };
    const client = new Client(options);
    await client.connect();
    const readOnly = await client.query<{ value: string }>(
      `SELECT current_setting('transaction_read_only') AS value`,
    );
    if (readOnly.rows[0]?.value !== 'on') {
      await client.end();
      throw new SnapshotError('SOURCE_PERMISSION_DENIED');
    }
    return client;
  }

  decryptPostgres(value: string | null): StoredPostgresConfig {
    if (!value) throw new SnapshotError('SOURCE_UNREACHABLE');
    return JSON.parse(
      this.decryptFor('postgres-config', value),
    ) as StoredPostgresConfig;
  }

  decryptSecret(value: string): string {
    return this.decryptFor('typesense-api-key', value);
  }

  private decryptFor(purpose: string, envelope: string): string {
    return this.decryptBufferFor(purpose, envelope).toString('utf8');
  }

  private decryptBufferFor(purpose: string, envelope: string): Buffer {
    return decryptEnvelope(
      purpose,
      envelope,
      config.APP_ENCRYPTION_KEY,
      config.APP_ENCRYPTION_KEY_PREVIOUS,
    );
  }

  encryptRootKey(parts: Parameters<typeof encodeCanonicalKey>[0]) {
    return this.encryptProjectionKey(parts, 'root');
  }

  encryptRelationKey(parts: Parameters<typeof encodeCanonicalKey>[0]): string {
    return this.encryptProjectionKey(parts, 'relation');
  }

  private encryptProjectionKey(
    parts: Parameters<typeof encodeCanonicalKey>[0],
    kind: 'root' | 'relation',
  ) {
    return encryptEnvelope(
      `projection-${kind}-key`,
      encodeCanonicalKey(parts),
      config.APP_ENCRYPTION_KEY,
    );
  }

  decryptRootKey(value: string) {
    return decodeCanonicalKey(
      this.decryptBufferFor('projection-root-key', value),
    );
  }
}

class SnapshotError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function projectionColumns(configValue: ProjectionConfig, relationId: string) {
  const columns = new Set<string>();
  for (const field of configValue.fields) {
    for (const path of [
      field.path,
      ...(field.concatPaths ?? []),
      ...(field.orderBy ?? []).map((item) => item.path),
    ]) {
      const [relation, column] = path.split('.');
      if (relation === relationId && column) columns.add(column);
    }
  }
  return columns;
}

function quote(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function groupBy<T>(rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }
  return [...groups.values()];
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
    throw new SnapshotError(
      `TYPESENSE_UNAVAILABLE:${response.status}`,
      response.status === 429 || response.status >= 500,
    );
  return response.text();
}

export async function tsDelete(
  credentials: { endpoint: string; apiKey: string },
  path: string,
) {
  const response = await fetch(new URL(path, `${credentials.endpoint}/`), {
    method: 'DELETE',
    headers: { 'x-typesense-api-key': credentials.apiKey },
    redirect: 'error',
    signal: AbortSignal.timeout(config.TYPESENSE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404)
    throw new SnapshotError(`TYPESENSE_UNAVAILABLE:${response.status}`);
}

export async function tsImport(
  credentials: { endpoint: string; apiKey: string },
  collection: string,
  documents: Array<Record<string, unknown>>,
): Promise<Array<{ success: boolean }>> {
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
  if (lines.length !== documents.length)
    return documents.map(() => ({ success: false }));
  return lines.map((line) => {
    try {
      return {
        success: (JSON.parse(line) as { success?: boolean }).success === true,
      };
    } catch {
      return { success: false };
    }
  });
}
