import { describe, expect, it } from 'vitest';

import type { PostgresDataset } from '../console-model';
import {
  operations,
  relationshipCandidates,
  tracking,
} from './projection-wizard';

const root: PostgresDataset = {
  schemaName: 'public',
  tableName: 'units',
  kind: 'BASE TABLE',
  columns: [
    { name: 'id', dataType: 'character', nullable: false },
    { name: 'type_id', dataType: 'character', nullable: false },
    {
      name: 'updated_at',
      dataType: 'timestamp with time zone',
      nullable: true,
    },
  ],
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [
    {
      columns: ['type_id'],
      referencedSchema: 'public',
      referencedTable: 'property_types',
      referencedColumns: ['id'],
    },
  ],
  indexes: [],
};

const typeTable: PostgresDataset = {
  schemaName: 'public',
  tableName: 'property_types',
  kind: 'BASE TABLE',
  columns: [
    { name: 'id', dataType: 'character', nullable: false },
    { name: 'name', dataType: 'character varying', nullable: false },
  ],
  primaryKey: ['id'],
  uniqueKeys: [],
  foreignKeys: [],
  indexes: [],
};

describe('relational projection wizard model', () => {
  it('turns catalog foreign keys into stable relationship choices', () => {
    const candidates = relationshipCandidates(root, [root, typeTable]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.relation).toMatchObject({
      id: 'public_property_types_type_id',
      kind: 'many_to_one',
      from: { relation: 'root', columns: ['type_id'] },
      to: { schema: 'public', table: 'property_types', columns: ['id'] },
    });
  });

  it('infers honest change tracking and bounded transform choices', () => {
    expect(tracking(root)).toEqual({
      mode: 'poll',
      updatedAt: 'updated_at',
      key: ['id'],
      overlapSeconds: 2,
    });
    expect(
      operations(
        {
          name: 'categories',
          type: 'string[]',
          searchable: true,
          facet: true,
          sort: false,
          optional: false,
        },
        true,
      ),
    ).toEqual(['unique_sorted_array']);
  });
});
