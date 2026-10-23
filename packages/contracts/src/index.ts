import { z } from 'zod';

export const dependencyHealthSchema = z.object({
  postgres: z.boolean(),
  redis: z.boolean(),
  typesense: z.boolean(),
});

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  dependencies: dependencyHealthSchema,
});

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
});

const passwordSchema = z.string().min(12).max(128);
const slugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const setupOwnerRequestSchema = z
  .object({
    email: z.email().max(254),
    password: passwordSchema,
  })
  .strict();

export const loginRequestSchema = setupOwnerRequestSchema;

export const createWorkspaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: slugSchema,
  })
  .strict();

export const updateWorkspaceRequestSchema = createWorkspaceRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export const createProjectRequestSchema = createWorkspaceRequestSchema.extend({
  typesenseConnectionId: z.uuid().optional(),
});
export const updateProjectRequestSchema = createProjectRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export const workspaceRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'EDITOR',
  'VIEWER',
]);

export const createMemberRequestSchema = z
  .object({
    email: z.email().max(254),
    password: passwordSchema,
    role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']),
  })
  .strict();

export const updateMemberRequestSchema = z
  .object({ role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']) })
  .strict();

export const createTypesenseConnectionRequestSchema = z.discriminatedUnion(
  'mode',
  [
    z
      .object({
        name: z.string().trim().min(1).max(100),
        mode: z.literal('BUNDLED'),
      })
      .strict(),
    z
      .object({
        name: z.string().trim().min(1).max(100),
        mode: z.literal('EXTERNAL'),
        endpoint: z.url(),
        apiKey: z.string().min(1).max(512),
        tlsPolicy: z.enum(['STRICT', 'ALLOW_INSECURE']).default('STRICT'),
      })
      .strict(),
  ],
);

export const indexFieldTypeSchema = z.enum([
  'string',
  'string[]',
  'int32',
  'int32[]',
  'int64',
  'float',
  'bool',
]);

export const indexFieldSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    type: indexFieldTypeSchema,
    searchable: z.boolean().default(false),
    facet: z.boolean().default(false),
    sort: z.boolean().default(false),
    optional: z.boolean().default(false),
  })
  .strict();

export const searchDefaultsSchema = z
  .object({ queryBy: z.array(z.string().min(1).max(64)).min(1).max(10) })
  .strict();

export const createSearchIndexRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: slugSchema,
    fields: z.array(indexFieldSchema).min(1).max(50),
    defaultSortingField: z.string().min(1).max(64).optional(),
    withDemoData: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.fields.map((field) => field.name);
    if (names.includes('id')) {
      context.addIssue({
        code: 'custom',
        message: 'The id field is implicit and must not be added to the schema',
      });
    }
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        message: 'Field names must be unique',
      });
    }
    if (
      !value.fields.some(
        (field) =>
          field.searchable &&
          (field.type === 'string' || field.type === 'string[]'),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'At least one string field must be searchable',
      });
    }
    if (value.defaultSortingField) {
      const sortingField = value.fields.find(
        (field) => field.name === value.defaultSortingField,
      );
      if (!sortingField?.sort) {
        context.addIssue({
          code: 'custom',
          message: 'Default sorting field must be a sortable schema field',
        });
      }
    }
  });

export const updateSearchIndexRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    searchDefaults: searchDefaultsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export const playgroundFilterSchema = z
  .object({
    field: z.string().min(1).max(64),
    operator: z.enum(['eq', 'gt', 'gte', 'lt', 'lte']),
    value: z.union([z.string().max(256), z.number(), z.boolean()]),
  })
  .strict();

export const playgroundSearchRequestSchema = z
  .object({
    q: z.string().max(512),
    queryBy: z.array(z.string().min(1).max(64)).min(1).max(10),
    filterBy: z.array(playgroundFilterSchema).max(10).optional(),
    facetBy: z.array(z.string().min(1).max(64)).max(10).optional(),
    sortBy: z
      .array(
        z
          .object({
            field: z.string().min(1).max(64),
            direction: z.enum(['asc', 'desc']),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    page: z.number().int().min(1).max(1_000).default(1),
    perPage: z.number().int().min(1).max(100).default(10),
  })
  .strict();

export const createSearchKeyRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    rateLimitOverride: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export const publicSearchRequestSchema = z
  .object({
    q: z.string().max(512),
    filter: z.array(playgroundFilterSchema).max(10).optional(),
    sort: z
      .array(
        z
          .object({
            field: z.string().min(1).max(64),
            direction: z.enum(['asc', 'desc']),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    facets: z.array(z.string().min(1).max(64)).max(10).optional(),
    page: z.number().int().min(1).max(1_000).default(1),
    perPage: z.number().int().min(1).max(100).default(10),
  })
  .strict()
  .refine((value) => value.page * value.perPage <= 10_000, {
    message: 'Requested result window exceeds 10000 records',
    path: ['page'],
  });

export const createSearchPresetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    settings: playgroundSearchRequestSchema,
  })
  .strict();

export const updateSearchPresetRequestSchema = createSearchPresetRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export const analyticsQuerySchema = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict();

export const auditQuerySchema = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const uploadMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    format: z.enum(['CSV', 'JSONL']),
  })
  .strict();

export const rebuildIndexRequestSchema = z
  .object({
    sourceId: z.uuid(),
    idField: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();

const postgresIdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);

export const createPostgresSourceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    connectionUrl: z.string().min(1).max(2_048),
    tlsPolicy: z.enum(['STRICT', 'ALLOW_INSECURE']).default('STRICT'),
  })
  .strict();

export const configurePostgresSourceRequestSchema = z
  .object({
    schemaName: postgresIdentifierSchema,
    tableName: postgresIdentifierSchema,
    primaryKeyField: postgresIdentifierSchema,
    updatedAtField: postgresIdentifierSchema,
    deletedAtField: postgresIdentifierSchema.optional(),
    fieldAllowlist: z.array(postgresIdentifierSchema).min(1).max(100),
    searchIndexId: z.uuid(),
    intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
  })
  .strict();

export const postgresPreviewRequestSchema = z
  .object({
    schemaName: postgresIdentifierSchema,
    tableName: postgresIdentifierSchema,
    fields: z.array(postgresIdentifierSchema).min(1).max(100),
    primaryKeyField: postgresIdentifierSchema,
  })
  .strict();

export const reconciliationExecuteRequestSchema = z
  .object({ token: z.string().min(32).max(256) })
  .strict();

const base64KeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'Must be a base64-encoded 32-byte key');
const optionalBase64KeySchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  base64KeySchema.optional(),
);
const previousBase64KeysSchema = z
  .string()
  .default('')
  .refine(
    (value) =>
      !value ||
      value
        .split(',')
        .map((item) => item.trim())
        .every((item) => /^[A-Za-z0-9+/]{43}=$/.test(item)),
    'Must be a comma-separated list of base64-encoded 32-byte keys',
  );

export const apiEnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  API_PORT: z.coerce.number().int().positive().max(65_535).default(3001),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  TYPESENSE_URL: z.url(),
  TYPESENSE_API_KEY: z.string().min(1),
  APP_ENCRYPTION_KEY: base64KeySchema,
  APP_ENCRYPTION_KEY_PREVIOUS: previousBase64KeysSchema,
  APP_HMAC_KEY: optionalBase64KeySchema,
  SEARCH_KEY_PEPPER: optionalBase64KeySchema,
  SEARCH_KEY_PEPPER_PREVIOUS: previousBase64KeysSchema,
  ALLOW_PRIVATE_TYPESENSE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOW_INSECURE_TYPESENSE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOW_PRIVATE_POSTGRES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOW_INSECURE_POSTGRES: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ENABLE_RELATIONAL_PROJECTIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TYPESENSE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(30_000)
    .default(5_000),
  UPLOAD_STAGING_DIR: z.string().min(1).default('/var/lib/osc/uploads'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100_000_000)
    .default(25_000_000),
  SETUP_TOKEN: z.string().min(16),
  APP_ORIGIN: z.url(),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  PUBLIC_SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  PUBLIC_SEARCH_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(60),
});

export const workerEnvironmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  REDIS_URL: z.url(),
  DATABASE_URL: z.url(),
  APP_ENCRYPTION_KEY: base64KeySchema,
  APP_ENCRYPTION_KEY_PREVIOUS: previousBase64KeysSchema,
  APP_HMAC_KEY: optionalBase64KeySchema,
  ENABLE_RELATIONAL_PROJECTIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TYPESENSE_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(30_000)
    .default(5_000),
  UPLOAD_STAGING_DIR: z.string().min(1).default('/var/lib/osc/uploads'),
  INGEST_BATCH_DOCUMENTS: z.coerce
    .number()
    .int()
    .min(10)
    .max(1_000)
    .default(500),
  INGEST_BATCH_BYTES: z.coerce
    .number()
    .int()
    .min(16_384)
    .max(5_000_000)
    .default(1_000_000),
  INGEST_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof workerEnvironmentSchema>;
export type SetupOwnerRequest = z.infer<typeof setupOwnerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;
export type UpdateWorkspaceRequest = z.infer<
  typeof updateWorkspaceRequestSchema
>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type CreateMemberRequest = z.infer<typeof createMemberRequestSchema>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type CreateTypesenseConnectionRequest = z.infer<
  typeof createTypesenseConnectionRequestSchema
>;
export type CreatePostgresSourceRequest = z.infer<
  typeof createPostgresSourceRequestSchema
>;
export type ConfigurePostgresSourceRequest = z.infer<
  typeof configurePostgresSourceRequestSchema
>;
export type PostgresPreviewRequest = z.infer<
  typeof postgresPreviewRequestSchema
>;
export type ReconciliationExecuteRequest = z.infer<
  typeof reconciliationExecuteRequestSchema
>;
export type IndexField = z.infer<typeof indexFieldSchema>;
export type CreateSearchIndexRequest = z.infer<
  typeof createSearchIndexRequestSchema
>;
export type UpdateSearchIndexRequest = z.infer<
  typeof updateSearchIndexRequestSchema
>;
export type PlaygroundSearchRequest = z.infer<
  typeof playgroundSearchRequestSchema
>;
export type CreateSearchKeyRequest = z.infer<
  typeof createSearchKeyRequestSchema
>;
export type PublicSearchRequest = z.infer<typeof publicSearchRequestSchema>;
export type CreateSearchPresetRequest = z.infer<
  typeof createSearchPresetRequestSchema
>;
export type UpdateSearchPresetRequest = z.infer<
  typeof updateSearchPresetRequestSchema
>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;
export type RebuildIndexRequest = z.infer<typeof rebuildIndexRequestSchema>;
