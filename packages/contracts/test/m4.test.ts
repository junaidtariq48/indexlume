import { describe, expect, it } from 'vitest';

import {
  configurePostgresSourceRequestSchema,
  postgresPreviewRequestSchema,
} from '../src/index.js';

describe('M4 PostgreSQL contracts', () => {
  it('accepts only the documented schedule intervals', () => {
    const valid = {
      schemaName: 'public',
      tableName: 'products',
      primaryKeyField: 'id',
      updatedAtField: 'updated_at',
      deletedAtField: 'deleted_at',
      fieldAllowlist: ['id', 'name', 'updated_at', 'deleted_at'],
      searchIndexId: '11111111-1111-4111-8111-111111111111',
      intervalMinutes: 15,
    };
    expect(configurePostgresSourceRequestSchema.safeParse(valid).success).toBe(
      true,
    );
    expect(
      configurePostgresSourceRequestSchema.safeParse({
        ...valid,
        intervalMinutes: 10,
      }).success,
    ).toBe(false);
  });

  it('rejects untrusted SQL identifiers', () => {
    expect(
      postgresPreviewRequestSchema.safeParse({
        schemaName: 'public',
        tableName: 'products; DROP TABLE users',
        fields: ['id'],
        primaryKeyField: 'id',
      }).success,
    ).toBe(false);
  });
});
