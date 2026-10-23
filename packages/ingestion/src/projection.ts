import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const identifierSchema = z.string().min(1).max(63).regex(IDENTIFIER_PATTERN);
const relationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const scalarSchema = z.union([
  z.string().max(1_024),
  z.number().finite(),
  z.boolean(),
]);

const pollChangeTrackingSchema = z
  .object({
    mode: z.literal('poll'),
    updatedAt: identifierSchema,
    key: z.array(identifierSchema).min(1).max(3),
    deletedAt: identifierSchema.optional(),
    overlapSeconds: z.number().int().min(0).max(300).default(2),
  })
  .strict();

const reconcileOnlyChangeTrackingSchema = z
  .object({ mode: z.literal('reconcile_only') })
  .strict();

export const projectionChangeTrackingSchema = z.discriminatedUnion('mode', [
  pollChangeTrackingSchema,
  reconcileOnlyChangeTrackingSchema,
]);

const predicateSchema = z.discriminatedUnion('op', [
  z
    .object({
      field: identifierSchema,
      op: z.literal('equals'),
      value: scalarSchema,
    })
    .strict(),
  z
    .object({
      field: identifierSchema,
      op: z.literal('not_equals'),
      value: scalarSchema,
    })
    .strict(),
  z
    .object({
      field: identifierSchema,
      op: z.literal('in'),
      values: z.array(scalarSchema).min(1).max(100),
    })
    .strict(),
  z.object({ field: identifierSchema, op: z.literal('is_null') }).strict(),
  z.object({ field: identifierSchema, op: z.literal('is_not_null') }).strict(),
  z
    .object({
      field: identifierSchema,
      op: z.enum(['gt', 'gte', 'lt', 'lte']),
      value: z.union([z.number().finite(), z.string().datetime()]),
    })
    .strict(),
]);

const fieldSchema = z
  .object({
    path: z
      .string()
      .regex(/^(?:root|[A-Za-z][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_$]*$/),
    targetField: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    op: z.enum([
      'identity',
      'string',
      'int64',
      'float',
      'bool',
      'sum',
      'count',
      'min',
      'max',
      'unique_sorted_array',
      'first',
      'top_n',
      'concat',
    ]),
    nullDefault: z
      .union([scalarSchema, z.array(scalarSchema).max(100)])
      .optional(),
    maxItems: z.number().int().min(1).max(1_000).optional(),
    concatPaths: z
      .array(
        z
          .string()
          .regex(/^(?:root|[A-Za-z][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_$]*$/),
      )
      .min(1)
      .max(10)
      .optional(),
    delimiter: z.string().max(16).optional(),
    maxLength: z.number().int().min(1).max(4_096).optional(),
    orderBy: z
      .array(
        z
          .object({
            path: z
              .string()
              .regex(
                /^(?:root|[A-Za-z][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_$]*$/,
              ),
            direction: z.enum(['asc', 'desc']),
          })
          .strict(),
      )
      .min(1)
      .max(3)
      .optional(),
    acknowledgeOmission: z.boolean().optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.op === 'unique_sorted_array' && !field.maxItems) {
      context.addIssue({
        code: 'custom',
        path: ['maxItems'],
        message: 'Array output requires maxItems',
      });
    }
    if (['first', 'top_n'].includes(field.op) && !field.orderBy) {
      context.addIssue({
        code: 'custom',
        path: ['orderBy'],
        message: 'First and top-N require an explicit stable order',
      });
    }
    if (
      field.op === 'top_n' &&
      (!field.maxItems || !field.orderBy || !field.acknowledgeOmission)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['acknowledgeOmission'],
        message:
          'Bounded top-N output requires maxItems, orderBy and acknowledged omission',
      });
    }
    if (
      field.op === 'concat' &&
      (!field.concatPaths || field.delimiter === undefined || !field.maxLength)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['concatPaths'],
        message: 'Concat requires selected paths, a delimiter and maxLength',
      });
    }
  });

export const projectionConfigSchema = z
  .object({
    version: z.literal(1),
    root: z
      .object({
        schema: identifierSchema,
        table: identifierSchema,
        pk: z.array(identifierSchema).length(1),
        idPrefix: z.string().max(64).default(''),
        eligibility: z
          .object({ deletedAtIsNull: identifierSchema })
          .strict()
          .optional(),
        changeTracking: projectionChangeTrackingSchema,
      })
      .strict(),
    relations: z
      .array(
        z
          .object({
            id: relationIdSchema,
            kind: z.enum(['many_to_one', 'one_to_many', 'one_to_one']),
            from: z
              .object({
                relation: z.union([z.literal('root'), relationIdSchema]),
                columns: z.array(identifierSchema).min(1).max(3),
              })
              .strict(),
            to: z
              .object({
                schema: identifierSchema,
                table: identifierSchema,
                columns: z.array(identifierSchema).min(1).max(3),
              })
              .strict(),
            required: z.boolean().default(false),
            limitPerRoot: z.number().int().min(1).max(2_500).optional(),
            predicates: z.array(predicateSchema).max(10).default([]),
            changeTracking: projectionChangeTrackingSchema,
          })
          .strict(),
      )
      .max(7),
    fields: z.array(fieldSchema).min(1).max(80),
    limits: z
      .object({
        maxTables: z.number().int().min(1).max(8),
        maxFields: z.number().int().min(1).max(80),
        maxRelationDepth: z.number().int().min(1).max(3),
        maxRowsPerRoot: z.number().int().min(1).max(2_500),
        maxDocumentBytes: z.number().int().min(1_024).max(262_144),
        batchRoots: z.number().int().min(1).max(100),
        queryTimeoutMs: z.number().int().min(100).max(5_000),
      })
      .strict(),
    sync: z
      .object({
        strategy: z.literal('poll_and_reconcile'),
        pollSeconds: z.number().int().min(60).max(86_400),
        reconcileHours: z.number().int().min(1).max(168),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const relationIds = new Set<string>();
    const depths = new Map<string, number>([['root', 0]]);
    config.relations.forEach((relation, index) => {
      if (relationIds.has(relation.id)) {
        context.addIssue({
          code: 'custom',
          path: ['relations', index, 'id'],
          message: 'Relation IDs must be unique',
        });
      }
      relationIds.add(relation.id);
      const parentDepth = depths.get(relation.from.relation);
      if (parentDepth === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['relations', index, 'from', 'relation'],
          message: 'Relation must reference root or an earlier relation',
        });
      } else {
        const depth = parentDepth + 1;
        depths.set(relation.id, depth);
        if (depth > config.limits.maxRelationDepth) {
          context.addIssue({
            code: 'custom',
            path: ['relations', index],
            message: 'Relation exceeds maxRelationDepth',
          });
        }
      }
      if (relation.from.columns.length !== relation.to.columns.length) {
        context.addIssue({
          code: 'custom',
          path: ['relations', index],
          message: 'Join column counts must match',
        });
      }
      if (
        (relation.limitPerRoot ?? config.limits.maxRowsPerRoot) >
        config.limits.maxRowsPerRoot
      ) {
        context.addIssue({
          code: 'custom',
          path: ['relations', index, 'limitPerRoot'],
          message: 'Relation limit exceeds maxRowsPerRoot',
        });
      }
    });
    if (config.relations.length + 1 > config.limits.maxTables) {
      context.addIssue({
        code: 'custom',
        path: ['relations'],
        message: 'Projection exceeds maxTables',
      });
    }
    if (config.fields.length > config.limits.maxFields) {
      context.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'Projection exceeds maxFields',
      });
    }
    const targets = new Set<string>();
    config.fields.forEach((field, index) => {
      const [relation] = field.path.split('.');
      if (relation !== 'root' && !relationIds.has(relation ?? '')) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'path'],
          message: 'Field path references an unknown relation',
        });
      }
      if (field.targetField === 'id') {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'targetField'],
          message: 'The generated id cannot be overridden',
        });
      }
      if (targets.has(field.targetField)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', index, 'targetField'],
          message: 'Target fields must be unique',
        });
      }
      targets.add(field.targetField);
    });
  });

export const createProjectionRequestSchema = z
  .object({
    sourceId: z.uuid(),
    searchIndexId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    config: projectionConfigSchema,
  })
  .strict();

export const updateProjectionVersionRequestSchema = z
  .object({
    config: projectionConfigSchema,
    expectedUpdatedAt: z.iso.datetime(),
  })
  .strict();

export const projectionVersionActionSchema = z
  .object({ versionId: z.uuid() })
  .strict();

export const projectionPreviewRequestSchema = projectionVersionActionSchema
  .extend({ limit: z.number().int().min(1).max(10).default(10) })
  .strict();

export const projectionPublishRequestSchema = projectionVersionActionSchema
  .extend({ eventualConsistencyAccepted: z.literal(true) })
  .strict();

export const projectionReconcileConfirmRequestSchema = z
  .object({
    token: z.string().min(43).max(128),
    expectedCount: z.number().int().min(0),
  })
  .strict();

export type ProjectionConfig = z.infer<typeof projectionConfigSchema>;
export type ProjectionPredicate = z.infer<typeof predicateSchema>;
export type CreateProjectionRequest = z.infer<
  typeof createProjectionRequestSchema
>;
export type UpdateProjectionVersionRequest = z.infer<
  typeof updateProjectionVersionRequestSchema
>;
export type ProjectionVersionAction = z.infer<
  typeof projectionVersionActionSchema
>;
export type ProjectionPreviewRequest = z.infer<
  typeof projectionPreviewRequestSchema
>;
export type ProjectionPublishRequest = z.infer<
  typeof projectionPublishRequestSchema
>;
export type ProjectionReconcileConfirmRequest = z.infer<
  typeof projectionReconcileConfirmRequestSchema
>;

export interface CatalogColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface CatalogForeignKey {
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface CatalogRelation {
  schema: string;
  table: string;
  kind: 'BASE TABLE' | 'VIEW';
  columns: CatalogColumn[];
  primaryKey: string[];
  uniqueKeys: string[][];
  foreignKeys: CatalogForeignKey[];
}

export interface ProjectionMappingField {
  name: string;
  type:
    'string' | 'string[]' | 'int32' | 'int32[]' | 'int64' | 'float' | 'bool';
}

export interface ProjectionValidationIssue {
  code: string;
  path: string;
  message: string;
}

function catalogKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

export function discoverCatalogRelationships(
  catalog: CatalogRelation[],
  root: { schema: string; table: string },
): Array<{
  from: string;
  to: string;
  columns: string[];
  referencedColumns: string[];
}> {
  const available = new Set(
    catalog.map((item) => catalogKey(item.schema, item.table)),
  );
  const rootKey = catalogKey(root.schema, root.table);
  if (!available.has(rootKey)) return [];
  return catalog.flatMap((relation) =>
    relation.foreignKeys
      .filter((foreignKey) =>
        available.has(
          catalogKey(foreignKey.referencedSchema, foreignKey.referencedTable),
        ),
      )
      .map((foreignKey) => ({
        from: `${relation.schema}.${relation.table}`,
        to: `${foreignKey.referencedSchema}.${foreignKey.referencedTable}`,
        columns: [...foreignKey.columns],
        referencedColumns: [...foreignKey.referencedColumns],
      })),
  );
}

export function validateProjectionCatalog(
  config: ProjectionConfig,
  catalog: CatalogRelation[],
  mapping: ProjectionMappingField[],
): ProjectionValidationIssue[] {
  const issues: ProjectionValidationIssue[] = [];
  const relations = new Map(
    catalog.map((item) => [catalogKey(item.schema, item.table), item]),
  );
  const configured = new Map<string, CatalogRelation>();
  const root = relations.get(catalogKey(config.root.schema, config.root.table));
  if (!root) {
    issues.push({
      code: 'INVALID_RELATION',
      path: 'root',
      message: 'Root relation is not in the allowed catalog',
    });
    return issues;
  }
  configured.set('root', root);
  const rootPk = config.root.pk;
  if (
    !isUniqueKey(root, rootPk) ||
    columns(root, rootPk).some((column) => !column || column.nullable)
  ) {
    issues.push({
      code: 'INVALID_ROOT_KEY',
      path: 'root.pk',
      message: 'Root key must be a non-null catalog unique key',
    });
  }
  validateChangeTracking(
    config.root.changeTracking,
    root,
    'root.changeTracking',
    issues,
  );
  if (
    config.root.eligibility &&
    !column(root, config.root.eligibility.deletedAtIsNull)
  ) {
    issues.push({
      code: 'INVALID_COLUMN',
      path: 'root.eligibility.deletedAtIsNull',
      message: 'Eligibility column is not in the allowed catalog',
    });
  }
  config.relations.forEach((relation, index) => {
    const target = relations.get(
      catalogKey(relation.to.schema, relation.to.table),
    );
    const source = configured.get(relation.from.relation);
    if (!target || !source) {
      issues.push({
        code: 'INVALID_RELATION',
        path: `relations.${index}`,
        message: 'Relation is not in the allowed catalog path',
      });
      return;
    }
    configured.set(relation.id, target);
    relation.from.columns.forEach((name, columnIndex) => {
      const fromColumn = column(source, name);
      const toColumn = column(target, relation.to.columns[columnIndex] ?? '');
      if (!fromColumn || !toColumn) {
        issues.push({
          code: 'INVALID_COLUMN',
          path: `relations.${index}`,
          message: 'Join column is not in the allowed catalog',
        });
      } else if (
        normalizePgType(fromColumn.dataType) !==
        normalizePgType(toColumn.dataType)
      ) {
        issues.push({
          code: 'INCOMPATIBLE_JOIN',
          path: `relations.${index}`,
          message: 'Join column types are incompatible',
        });
      }
    });
    relation.predicates.forEach((predicate, predicateIndex) => {
      if (!column(target, predicate.field)) {
        issues.push({
          code: 'INVALID_COLUMN',
          path: `relations.${index}.predicates.${predicateIndex}.field`,
          message: 'Predicate field is not in the allowed catalog',
        });
      }
    });
    validateChangeTracking(
      relation.changeTracking,
      target,
      `relations.${index}.changeTracking`,
      issues,
    );
  });
  const mappingByName = new Map(mapping.map((field) => [field.name, field]));
  config.fields.forEach((field, index) => {
    const [relationId, fieldName] = field.path.split('.');
    const relation = configured.get(relationId ?? '');
    if (!relation || !fieldName || !column(relation, fieldName)) {
      issues.push({
        code: 'INVALID_COLUMN',
        path: `fields.${index}.path`,
        message: 'Field path is not in the allowed catalog',
      });
    }
    for (const [pathIndex, extraPath] of [
      ...(field.concatPaths ?? []),
      ...(field.orderBy ?? []).map((order) => order.path),
    ].entries()) {
      const [extraRelationId, extraFieldName] = extraPath.split('.');
      const extraRelation = configured.get(extraRelationId ?? '');
      if (
        !extraRelation ||
        !extraFieldName ||
        !column(extraRelation, extraFieldName)
      ) {
        issues.push({
          code: 'INVALID_COLUMN',
          path: `fields.${index}.parameters.${pathIndex}`,
          message: 'Transform parameter path is not in the allowed catalog',
        });
      }
    }
    if (field.op === 'first' || field.op === 'top_n') {
      const orderPaths = field.orderBy ?? [];
      const orderRelations = new Set(
        orderPaths.map((order) => order.path.split('.')[0]),
      );
      const orderFields = orderPaths.map(
        (order) => order.path.split('.')[1] ?? '',
      );
      if (
        !relation ||
        orderRelations.size !== 1 ||
        !orderRelations.has(relationId) ||
        !hasUniqueOrdering(relation, orderFields)
      ) {
        issues.push({
          code: 'NON_DETERMINISTIC_ORDER',
          path: `fields.${index}.orderBy`,
          message:
            'First and top-N ordering must end in a unique key from the same relation',
        });
      }
    }
    const target = mappingByName.get(field.targetField);
    if (!target) {
      issues.push({
        code: 'INVALID_TARGET_FIELD',
        path: `fields.${index}.targetField`,
        message: 'Target field is not in the SearchIndex mapping',
      });
    } else if (!compatibleOutput(field.op, target.type)) {
      issues.push({
        code: 'INVALID_TARGET_TYPE',
        path: `fields.${index}`,
        message:
          'Transform output is incompatible with the SearchIndex mapping',
      });
    } else if (
      relation &&
      fieldName &&
      !compatibleInput(
        field.op,
        column(relation, fieldName)?.dataType,
        target.type,
      )
    ) {
      issues.push({
        code: 'INVALID_SOURCE_TYPE',
        path: `fields.${index}`,
        message:
          'Source column type is incompatible with the selected transform',
      });
    }
  });
  const configuredTargets = new Set(
    config.fields.map((field) => field.targetField),
  );
  mapping
    .filter(
      (field) => field.name !== 'id' && !configuredTargets.has(field.name),
    )
    .forEach((field) =>
      issues.push({
        code: 'UNMAPPED_TARGET_FIELD',
        path: `mapping.${field.name}`,
        message:
          'Every SearchIndex field must have exactly one projection mapping',
      }),
    );
  return issues;
}

function validateChangeTracking(
  tracking: ProjectionConfig['root']['changeTracking'],
  relation: CatalogRelation,
  path: string,
  issues: ProjectionValidationIssue[],
): void {
  if (tracking.mode === 'reconcile_only') return;
  const updated = column(relation, tracking.updatedAt);
  if (!updated || !normalizePgType(updated.dataType).includes('timestamp')) {
    issues.push({
      code: 'CURSOR_UNSUPPORTED',
      path: `${path}.updatedAt`,
      message: 'Polling requires a timestamp cursor column',
    });
  }
  if (
    !isUniqueKey(relation, tracking.key) ||
    columns(relation, tracking.key).some((item) => !item || item.nullable)
  ) {
    issues.push({
      code: 'CURSOR_UNSUPPORTED',
      path: `${path}.key`,
      message: 'Polling cursor key must be a non-null unique key',
    });
  }
  if (tracking.deletedAt && !column(relation, tracking.deletedAt)) {
    issues.push({
      code: 'INVALID_COLUMN',
      path: `${path}.deletedAt`,
      message: 'Soft-delete column is not in the allowed catalog',
    });
  }
}

function column(
  relation: CatalogRelation,
  name: string,
): CatalogColumn | undefined {
  return relation.columns.find((item) => item.name === name);
}

function columns(
  relation: CatalogRelation,
  names: string[],
): Array<CatalogColumn | undefined> {
  return names.map((name) => column(relation, name));
}

function isUniqueKey(relation: CatalogRelation, names: string[]): boolean {
  return [relation.primaryKey, ...relation.uniqueKeys].some(
    (key) =>
      key.length === names.length &&
      key.every((name, index) => name === names[index]),
  );
}

function normalizePgType(value: string): string {
  if (['int2', 'int4', 'int8', 'smallint', 'integer', 'bigint'].includes(value))
    return 'integer';
  if (['varchar', 'character varying', 'text', 'citext'].includes(value))
    return 'text';
  if (value.startsWith('timestamp')) return 'timestamp';
  return value;
}

function compatibleOutput(
  op: ProjectionConfig['fields'][number]['op'],
  target: ProjectionMappingField['type'],
): boolean {
  if (op === 'unique_sorted_array') return target.endsWith('[]');
  if (op === 'top_n') return target.endsWith('[]');
  if (op === 'sum') return ['int32', 'int64', 'float'].includes(target);
  if (op === 'count') return ['int32', 'int64'].includes(target);
  if (op === 'string' || op === 'concat') return target === 'string';
  if (op === 'int64') return target === 'int64';
  if (op === 'float') return target === 'float';
  if (op === 'bool') return target === 'bool';
  return !target.endsWith('[]');
}

function compatibleInput(
  op: ProjectionConfig['fields'][number]['op'],
  sourceType: string | undefined,
  targetType: ProjectionMappingField['type'],
): boolean {
  if (!sourceType) return false;
  if (['string', 'int64', 'float', 'bool', 'count', 'concat'].includes(op)) {
    return true;
  }
  const source = normalizePgType(sourceType);
  if (['sum', 'min', 'max'].includes(op)) {
    return [
      'integer',
      'numeric',
      'real',
      'double precision',
      'decimal',
    ].includes(source);
  }
  const scalarTarget = targetType.replace(/\[\]$/, '');
  if (source === 'text') return scalarTarget === 'string';
  if (source === 'boolean') return scalarTarget === 'bool';
  if (source === 'integer') {
    return ['int32', 'int64', 'float'].includes(scalarTarget);
  }
  if (['numeric', 'real', 'double precision', 'decimal'].includes(source)) {
    return scalarTarget === 'float';
  }
  return op !== 'identity' && op !== 'unique_sorted_array' && op !== 'top_n';
}

function hasUniqueOrdering(
  relation: CatalogRelation,
  orderFields: string[],
): boolean {
  return [relation.primaryKey, ...relation.uniqueKeys].some(
    (key) =>
      key.length > 0 && key.every((field) => orderFields.includes(field)),
  );
}

export interface CompiledSelect {
  readonly kind: 'projection-select';
  readonly text: string;
  readonly values: readonly unknown[];
}

export function quotePostgresIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value) || value.length > 63)
    throw new Error('Unsafe PostgreSQL identifier');
  return `"${value.replaceAll('"', '""')}"`;
}

export function compileRootPageQuery(
  config: ProjectionConfig,
  afterKey: unknown | undefined,
): CompiledSelect {
  const pk = quotePostgresIdentifier(config.root.pk[0] ?? '');
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (config.root.eligibility)
    conditions.push(
      `${quotePostgresIdentifier(config.root.eligibility.deletedAtIsNull)} IS NULL`,
    );
  if (afterKey !== undefined) {
    values.push(afterKey);
    conditions.push(`${pk} > $${values.length}`);
  }
  values.push(config.limits.batchRoots);
  return {
    kind: 'projection-select',
    text: `SELECT ${pk} FROM ${quotePostgresIdentifier(config.root.schema)}.${quotePostgresIdentifier(config.root.table)}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${pk} ASC LIMIT $${values.length}`,
    values,
  };
}

export function compileRelationFetchQuery(
  relation: ProjectionConfig['relations'][number],
  selectedColumns: string[],
  joinKeys: unknown[][],
): CompiledSelect {
  if (!joinKeys.length || joinKeys.length > 100)
    throw new Error('Relation fetch requires 1 to 100 join keys');
  if (joinKeys.some((key) => key.length !== relation.to.columns.length))
    throw new Error('Join key shape does not match relation');
  const selected = [...new Set([...relation.to.columns, ...selectedColumns])]
    .map(quotePostgresIdentifier)
    .join(', ');
  const values: unknown[] = [];
  let keyPredicate: string;
  if (relation.to.columns.length === 1) {
    values.push(joinKeys.map((key) => key[0]));
    keyPredicate = `${quotePostgresIdentifier(relation.to.columns[0] ?? '')} = ANY($1)`;
  } else {
    const tuples = joinKeys.map((key) => {
      const placeholders = key.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    keyPredicate = `(${relation.to.columns.map(quotePostgresIdentifier).join(', ')}) IN (${tuples.join(', ')})`;
  }
  const predicates = relation.predicates.map((predicate) =>
    compilePredicate(predicate, values),
  );
  const limit =
    Math.min(relation.limitPerRoot ?? 2_500, 2_500) * joinKeys.length;
  values.push(limit);
  return {
    kind: 'projection-select',
    text: `SELECT ${selected} FROM ${quotePostgresIdentifier(relation.to.schema)}.${quotePostgresIdentifier(relation.to.table)} WHERE ${[keyPredicate, ...predicates].join(' AND ')} ORDER BY ${relation.to.columns.map(quotePostgresIdentifier).join(', ')} ASC LIMIT $${values.length}`,
    values,
  };
}

function compilePredicate(
  predicate: ProjectionPredicate,
  values: unknown[],
): string {
  const field = quotePostgresIdentifier(predicate.field);
  if (predicate.op === 'is_null') return `${field} IS NULL`;
  if (predicate.op === 'is_not_null') return `${field} IS NOT NULL`;
  if (predicate.op === 'in') {
    values.push(predicate.values);
    return `${field} = ANY($${values.length})`;
  }
  values.push(predicate.value);
  const operator = {
    equals: '=',
    not_equals: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  }[predicate.op];
  return `${field} ${operator} $${values.length}`;
}

export function compileExplainQuery(query: CompiledSelect): CompiledSelect {
  return { ...query, text: `EXPLAIN (FORMAT JSON) ${query.text}` };
}

export function assessExplainPlan(
  value: unknown,
  limits: { maxTotalCost: number; maxPlanRows: number },
): { accepted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const root = Array.isArray(value) ? value[0] : undefined;
  const plan =
    isRecord(root) && isRecord(root['Plan']) ? root['Plan'] : undefined;
  if (!plan)
    return { accepted: false, reasons: ['EXPLAIN result has no plan'] };
  const visit = (node: Record<string, unknown>) => {
    const type = node['Node Type'];
    if (typeof type === 'string' && /Modify|Insert|Update|Delete/.test(type))
      reasons.push('Plan contains a write node');
    const cost = node['Total Cost'];
    if (typeof cost === 'number' && cost > limits.maxTotalCost)
      reasons.push('Plan total cost exceeds the configured limit');
    const rows = node['Plan Rows'];
    if (typeof rows === 'number' && rows > limits.maxPlanRows)
      reasons.push('Plan row estimate exceeds the configured limit');
    const children = node['Plans'];
    if (Array.isArray(children)) children.filter(isRecord).forEach(visit);
  };
  visit(plan);
  return { accepted: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type CanonicalKeyPart =
  string | number | bigint | boolean | Date | Buffer;

export function encodeCanonicalKey(parts: readonly CanonicalKeyPart[]): Buffer {
  if (!parts.length || parts.length > 3)
    throw new Error('Canonical keys require 1 to 3 components');
  const encoded = parts.map((part) => {
    let tag: number;
    let payload: Buffer;
    if (typeof part === 'string')
      [tag, payload] = [1, Buffer.from(part, 'utf8')];
    else if (typeof part === 'bigint')
      [tag, payload] = [2, Buffer.from(part.toString(10))];
    else if (typeof part === 'number') {
      if (!Number.isFinite(part))
        throw new Error('Canonical numeric keys must be finite');
      [tag, payload] = Number.isSafeInteger(part)
        ? [3, Buffer.from(part.toString(10))]
        : [4, Buffer.from(Object.is(part, -0) ? '-0' : part.toString())];
    } else if (typeof part === 'boolean')
      [tag, payload] = [5, Buffer.from(part ? [1] : [0])];
    else if (part instanceof Date) {
      if (Number.isNaN(part.valueOf()))
        throw new Error('Canonical date keys must be valid');
      [tag, payload] = [6, Buffer.from(part.toISOString())];
    } else [tag, payload] = [7, part];
    const header = Buffer.alloc(5);
    header[0] = tag;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  });
  return Buffer.concat([Buffer.from([1, parts.length]), ...encoded]);
}

export function decodeCanonicalKey(value: Buffer): CanonicalKeyPart[] {
  if (value.length < 2 || value[0] !== 1)
    throw new Error('Unsupported canonical key version');
  const count = value[1]!;
  if (count < 1 || count > 3)
    throw new Error('Canonical keys require 1 to 3 components');
  const parts: CanonicalKeyPart[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    if (offset + 5 > value.length) throw new Error('Malformed canonical key');
    const tag = value[offset]!;
    const length = value.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + length > value.length)
      throw new Error('Malformed canonical key');
    const payload = value.subarray(offset, offset + length);
    offset += length;
    if (tag === 1) parts.push(payload.toString('utf8'));
    else if (tag === 2) parts.push(BigInt(payload.toString('utf8')));
    else if (tag === 3 || tag === 4) {
      const parsed = Number(payload.toString('utf8'));
      if (!Number.isFinite(parsed)) throw new Error('Malformed canonical key');
      parts.push(parsed);
    } else if (tag === 5) {
      if (payload.length !== 1 || (payload[0] !== 0 && payload[0] !== 1))
        throw new Error('Malformed canonical key');
      parts.push(payload[0] === 1);
    } else if (tag === 6) {
      const parsed = new Date(payload.toString('utf8'));
      if (Number.isNaN(parsed.valueOf()))
        throw new Error('Malformed canonical key');
      parts.push(parsed);
    } else if (tag === 7) parts.push(Buffer.from(payload));
    else throw new Error('Unsupported canonical key type');
  }
  if (offset !== value.length) throw new Error('Malformed canonical key');
  return parts;
}

export function projectionDocumentId(
  parts: readonly CanonicalKeyPart[],
  prefix = '',
): string {
  return `${prefix}v1_${encodeCanonicalKey(parts).toString('base64url')}`;
}

export function protectedKeyHmac(
  parts: readonly CanonicalKeyPart[],
  key: Buffer,
): string {
  if (key.length < 32)
    throw new Error('HMAC key must contain at least 32 bytes');
  return createHmac('sha256', key)
    .update('osc:projection-key:v1\0')
    .update(encodeCanonicalKey(parts))
    .digest('hex');
}

export function projectionConfigHash(config: ProjectionConfig): string {
  return createHash('sha256').update(stableJson(config)).digest('hex');
}

export interface ProjectionReconcileBinding {
  runId: string;
  projectionVersionId: string;
  activeIndexGenerationId: string;
  candidateSetDigest: string;
  expectedCount: number;
  expiresAt: string;
}

export function projectionCandidateSetDigest(
  candidates: ReadonlyArray<{
    rootKeyHmac: string;
    documentId: string;
    reason: string;
  }>,
): string {
  const canonical = [...candidates]
    .sort(
      (left, right) =>
        left.rootKeyHmac.localeCompare(right.rootKeyHmac) ||
        left.documentId.localeCompare(right.documentId),
    )
    .map((candidate) => ({
      rootKeyHmac: candidate.rootKeyHmac,
      documentId: candidate.documentId,
      reason: candidate.reason,
    }));
  return createHash('sha256')
    .update('osc:projection-reconcile-candidates:v1\n')
    .update(stableJson(canonical))
    .digest('hex');
}

export function projectionReconcileToken(
  binding: ProjectionReconcileBinding,
  key: Buffer,
): string {
  return createHmac('sha256', key)
    .update('osc:projection-reconcile-approval:v1\n')
    .update(stableJson(binding))
    .digest('base64url');
}

export function projectionReconcileTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function projectionReconciliationCanExecute(input: {
  status: string;
  complete: boolean;
  expectedCount: number;
  actualCount: number;
  candidateSetDigest: string | null;
  actualCandidateSetDigest: string;
  expiresAt: Date | null;
  now?: Date;
}): boolean {
  return (
    input.status === 'AWAITING_CONFIRMATION' &&
    input.complete &&
    input.expectedCount === input.actualCount &&
    Boolean(input.candidateSetDigest) &&
    input.candidateSetDigest === input.actualCandidateSetDigest &&
    Boolean(input.expiresAt) &&
    input.expiresAt! > (input.now ?? new Date())
  );
}

export function projectionReconciliationDue(input: {
  reconcileHours: number;
  now: Date;
  latest?: {
    status: string;
    createdAt: Date;
    expiresAt: Date | null;
  };
}): boolean {
  const latest = input.latest;
  if (!latest) return true;
  if (['QUEUED', 'SCANNING', 'EXECUTING'].includes(latest.status)) return false;
  if (
    latest.status === 'AWAITING_CONFIRMATION' &&
    latest.expiresAt &&
    latest.expiresAt > input.now
  )
    return false;
  return (
    latest.createdAt.getTime() + input.reconcileHours * 60 * 60_000 <=
    input.now.getTime()
  );
}

export function projectionSchemaFingerprint(
  config: ProjectionConfig,
  catalog: CatalogRelation[],
): string {
  const required = new Set([
    catalogKey(config.root.schema, config.root.table),
    ...config.relations.map((relation) =>
      catalogKey(relation.to.schema, relation.to.table),
    ),
  ]);
  const evidence = catalog
    .filter((relation) =>
      required.has(catalogKey(relation.schema, relation.table)),
    )
    .map((relation) => ({
      schema: relation.schema,
      table: relation.table,
      kind: relation.kind,
      columns: [...relation.columns].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      primaryKey: relation.primaryKey,
      uniqueKeys: [...relation.uniqueKeys].sort((left, right) =>
        left.join('\u0000').localeCompare(right.join('\u0000')),
      ),
      foreignKeys: [...relation.foreignKeys].sort((left, right) =>
        stableJson(left).localeCompare(stableJson(right)),
      ),
    }))
    .sort((left, right) =>
      catalogKey(left.schema, left.table).localeCompare(
        catalogKey(right.schema, right.table),
      ),
    );
  if (evidence.length !== required.size) {
    throw new Error('Schema fingerprint requires every configured relation');
  }
  return createHash('sha256').update(stableJson(evidence)).digest('hex');
}

export function stableJson(value: unknown): string {
  if (value === undefined)
    throw new Error('Undefined is not valid canonical JSON');
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error('Value is not valid canonical JSON');
  return encoded;
}

export interface ProjectionCompositionState {
  rootKeyParts: CanonicalKeyPart[];
  rootKeyHash: string;
  documentId: string;
  canonicalHash?: string;
  terminalState: 'COMPOSED' | 'FAILED';
}

export function projectionDependencyKeys(
  config: ProjectionConfig,
  rowsByRelation: Map<string, Map<string, Array<Record<string, unknown>>>>,
  rootKeyHash: string,
): Array<{ relationId: string; keyParts: CanonicalKeyPart[] }> {
  const identities = new Map<
    string,
    { relationId: string; keyParts: CanonicalKeyPart[] }
  >();
  for (const relation of config.relations) {
    const columns =
      relation.changeTracking.mode === 'poll'
        ? relation.changeTracking.key
        : relation.to.columns;
    for (const row of rowsByRelation.get(relation.id)?.get(rootKeyHash) ?? []) {
      const keyParts = columns.map((column) => projectionKeyPart(row[column]));
      const identity = `${relation.id}\0${encodeCanonicalKey(keyParts).toString('base64url')}`;
      identities.set(identity, { relationId: relation.id, keyParts });
    }
  }
  return [...identities.values()];
}

export function composeProjectionDocuments(
  config: ProjectionConfig,
  rootRows: Array<Record<string, unknown>>,
  rowsByRelation: Map<string, Map<string, Array<Record<string, unknown>>>>,
): {
  documents: Array<Record<string, unknown>>;
  diagnostics: Array<{ code: string; message: string; root: string }>;
  states: ProjectionCompositionState[];
} {
  const documents: Array<Record<string, unknown>> = [];
  const diagnostics: Array<{ code: string; message: string; root: string }> =
    [];
  const states: ProjectionCompositionState[] = [];
  for (const rootRow of rootRows) {
    const rootKeyParts = config.root.pk.map((column) =>
      projectionKeyPart(rootRow[column]),
    );
    const rootKeyHash = stableJson(
      config.root.pk.map((column) => rootRow[column]),
    );
    const documentId = projectionDocumentId(rootKeyParts, config.root.idPrefix);
    try {
      const missingRequired = config.relations.find(
        (relation) =>
          relation.required &&
          !(rowsByRelation.get(relation.id)?.get(rootKeyHash)?.length ?? 0),
      );
      if (missingRequired) {
        throw new Error(`REQUIRED_RELATION_MISSING:${missingRequired.id}`);
      }
      const document: Record<string, unknown> = { id: documentId };
      for (const field of config.fields) {
        const [relationId, columnName] = splitProjectionPath(field.path);
        const rows = rowsByRelation.get(relationId)?.get(rootKeyHash) ?? [];
        let value: unknown;
        if (field.op === 'concat') {
          value = concatProjectionScalars(
            [field.path, ...(field.concatPaths ?? [])].map((path) => {
              const [pathRelation, pathColumn] = splitProjectionPath(path);
              return rowsByRelation.get(pathRelation)?.get(rootKeyHash)?.[0]?.[
                pathColumn
              ];
            }),
            field.delimiter ?? '',
            field.maxLength ?? 1,
          );
        } else if (field.op === 'first' || field.op === 'top_n') {
          const orderBy = field.orderBy ?? [];
          const ordered = selectOrderedProjectionValues(
            rows,
            (row) =>
              orderBy.map((order) => {
                const [, orderColumn] = splitProjectionPath(order.path);
                return projectionOrderPart(row[orderColumn]);
              }),
            orderBy.map((order) => order.direction),
            field.op === 'first' ? 1 : (field.maxItems ?? 1),
            field.op === 'first' || Boolean(field.acknowledgeOmission),
          );
          value =
            field.op === 'first'
              ? ordered[0]?.[columnName]
              : ordered.map((row) => row[columnName]);
        } else if (
          ['sum', 'count', 'min', 'max', 'unique_sorted_array'].includes(
            field.op,
          )
        ) {
          value = aggregateProjectionValues(
            field.op as 'sum' | 'count' | 'min' | 'max' | 'unique_sorted_array',
            rows.map((row) => row[columnName]),
            { maxItems: field.maxItems },
          );
        } else {
          value = rows[0]?.[columnName];
          if (['string', 'int64', 'float', 'bool'].includes(field.op)) {
            value = castProjectionScalar(
              value,
              field.op as 'string' | 'int64' | 'float' | 'bool',
            );
          }
        }
        if (
          (value === null || value === undefined) &&
          field.nullDefault !== undefined
        ) {
          value = field.nullDefault;
        }
        document[field.targetField] = value ?? null;
      }
      const canonical = stableJson(document);
      if (Buffer.byteLength(canonical) > config.limits.maxDocumentBytes) {
        throw new Error('DOCUMENT_TOO_LARGE');
      }
      documents.push(document);
      states.push({
        rootKeyParts,
        rootKeyHash,
        documentId,
        canonicalHash: createHash('sha256').update(canonical).digest('hex'),
        terminalState: 'COMPOSED',
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'COMPOSITION_FAILED';
      const [candidate] = raw.split(':');
      const code = [
        'REQUIRED_RELATION_MISSING',
        'FANOUT_LIMIT',
        'DOCUMENT_TOO_LARGE',
        'INVALID_TYPE_CAST',
      ].includes(candidate ?? '')
        ? candidate!
        : 'COMPOSITION_FAILED';
      diagnostics.push({
        code,
        message:
          code === 'REQUIRED_RELATION_MISSING'
            ? 'A required related row is missing'
            : `Projection composition failed: ${code}`,
        root: documentId,
      });
      states.push({
        rootKeyParts,
        rootKeyHash,
        documentId,
        terminalState: 'FAILED',
      });
    }
  }
  return { documents, diagnostics, states };
}

function splitProjectionPath(path: string): [string, string] {
  const [relation, column, extra] = path.split('.');
  if (!relation || !column || extra) throw new Error('INVALID_COLUMN');
  return [relation, column];
}

function projectionKeyPart(value: unknown): CanonicalKeyPart {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    Buffer.isBuffer(value)
  ) {
    return value;
  }
  throw new Error('NULL_ROOT_KEY');
}

function projectionOrderPart(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  throw new Error('INVALID_TYPE_CAST');
}

export function uniqueSortedArray(
  values: readonly unknown[],
  maxItems: number,
): unknown[] {
  const byCanonical = new Map(
    values.map((value) => [stableJson(value), value]),
  );
  const sorted = [...byCanonical.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (sorted.length > maxItems) throw new Error('FANOUT_LIMIT');
  return sorted.map(([, value]) => value);
}

export function aggregateProjectionValues(
  operation: 'sum' | 'count' | 'min' | 'max' | 'unique_sorted_array',
  values: readonly unknown[],
  options: { maxItems?: number } = {},
): unknown {
  const present = values.filter(
    (value) => value !== null && value !== undefined,
  );
  if (operation === 'count') return present.length;
  if (operation === 'unique_sorted_array') {
    if (!options.maxItems) throw new Error('Array aggregate requires maxItems');
    return uniqueSortedArray(present, options.maxItems);
  }
  if (operation === 'sum') {
    if (
      !present.every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      )
    )
      throw new Error('INVALID_TYPE_CAST');
    const total = (present as number[]).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total)) throw new Error('INVALID_TYPE_CAST');
    return total;
  }
  if (!present.length) return null;
  if (
    !present.every(
      (value) =>
        typeof value === typeof present[0] &&
        (typeof value === 'number' || typeof value === 'string'),
    )
  ) {
    throw new Error('INVALID_TYPE_CAST');
  }
  const ordered = [...(present as Array<number | string>)].sort(
    (left, right) =>
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right)),
  );
  return operation === 'min' ? ordered[0] : ordered.at(-1);
}

export function assertProjectionVersionEditable(
  status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'ARCHIVED',
): void {
  if (status !== 'DRAFT') {
    throw new Error('Projection versions are immutable after validation');
  }
}

export function concatProjectionScalars(
  values: readonly unknown[],
  delimiter: string,
  maxLength: number,
): string {
  const output = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => {
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error('INVALID_TYPE_CAST');
      }
      return String(value);
    })
    .join(delimiter);
  if (output.length > maxLength) throw new Error('DOCUMENT_TOO_LARGE');
  return output;
}

export function selectOrderedProjectionValues<T>(
  values: readonly T[],
  orderValue: (value: T) => readonly (string | number | boolean | null)[],
  direction: readonly ('asc' | 'desc')[],
  maximum: number,
  acknowledgeOmission: boolean,
): T[] {
  if (maximum < 1 || direction.length < 1)
    throw new Error('Invalid stable order');
  const ordered = [...values].sort((left, right) => {
    const leftKey = orderValue(left);
    const rightKey = orderValue(right);
    if (
      leftKey.length !== direction.length ||
      rightKey.length !== direction.length
    ) {
      throw new Error('Invalid stable order');
    }
    for (let index = 0; index < direction.length; index += 1) {
      const leftPart = stableJson(leftKey[index]);
      const rightPart = stableJson(rightKey[index]);
      const comparison = leftPart.localeCompare(rightPart);
      if (comparison)
        return direction[index] === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
  if (ordered.length > maximum && !acknowledgeOmission)
    throw new Error('FANOUT_LIMIT');
  return ordered.slice(0, maximum);
}

export function castProjectionScalar(
  value: unknown,
  target: 'string' | 'int64' | 'float' | 'bool',
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (target === 'string') {
    if (!['string', 'number', 'boolean'].includes(typeof value))
      throw new Error('INVALID_TYPE_CAST');
    return String(value);
  }
  if (target === 'bool') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error('INVALID_TYPE_CAST');
  }
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) throw new Error('INVALID_TYPE_CAST');
  if (target === 'int64' && !Number.isSafeInteger(numeric))
    throw new Error('INVALID_TYPE_CAST');
  return numeric;
}
