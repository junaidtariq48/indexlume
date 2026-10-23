import { describe, expect, it } from 'vitest';

import {
  assessExplainPlan,
  aggregateProjectionValues,
  assertProjectionVersionEditable,
  castProjectionScalar,
  composeProjectionDocuments,
  compileExplainQuery,
  compileRelationFetchQuery,
  compileRootPageQuery,
  concatProjectionScalars,
  decodeCanonicalKey,
  discoverCatalogRelationships,
  encodeCanonicalKey,
  projectionConfigHash,
  projectionCandidateSetDigest,
  projectionConfigSchema,
  projectionDocumentId,
  projectionDependencyKeys,
  projectionPublishRequestSchema,
  projectionReconcileConfirmRequestSchema,
  projectionReconcileToken,
  projectionReconcileTokenHash,
  projectionReconciliationCanExecute,
  projectionReconciliationDue,
  projectionSchemaFingerprint,
  protectedKeyHmac,
  quotePostgresIdentifier,
  selectOrderedProjectionValues,
  uniqueSortedArray,
  validateProjectionCatalog,
  type CatalogRelation,
  type ProjectionConfig,
} from '../src/index.js';

const input = {
  version: 1,
  root: {
    schema: 'public',
    table: 'products',
    pk: ['id'],
    idPrefix: 'product-',
    eligibility: { deletedAtIsNull: 'deleted_at' },
    changeTracking: {
      mode: 'poll',
      updatedAt: 'updated_at',
      key: ['id'],
      overlapSeconds: 2,
    },
  },
  relations: [
    {
      id: 'inventory',
      kind: 'one_to_many',
      from: { relation: 'root', columns: ['id'] },
      to: { schema: 'public', table: 'inventory', columns: ['product_id'] },
      limitPerRoot: 100,
      predicates: [{ field: 'active', op: 'equals', value: true }],
      changeTracking: {
        mode: 'poll',
        updatedAt: 'updated_at',
        key: ['id'],
        overlapSeconds: 2,
      },
    },
  ],
  fields: [
    { path: 'root.name', targetField: 'name', op: 'identity' },
    {
      path: 'inventory.quantity',
      targetField: 'stock',
      op: 'sum',
      nullDefault: 0,
    },
  ],
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
} as const;

const catalog: CatalogRelation[] = [
  {
    schema: 'public',
    table: 'products',
    kind: 'BASE TABLE',
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false },
      { name: 'name', dataType: 'text', nullable: false },
      {
        name: 'deleted_at',
        dataType: 'timestamp with time zone',
        nullable: true,
      },
      {
        name: 'updated_at',
        dataType: 'timestamp with time zone',
        nullable: false,
      },
    ],
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: [],
  },
  {
    schema: 'public',
    table: 'inventory',
    kind: 'BASE TABLE',
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false },
      { name: 'product_id', dataType: 'bigint', nullable: false },
      { name: 'quantity', dataType: 'integer', nullable: false },
      { name: 'active', dataType: 'boolean', nullable: false },
      {
        name: 'updated_at',
        dataType: 'timestamp with time zone',
        nullable: false,
      },
    ],
    primaryKey: ['id'],
    uniqueKeys: [],
    foreignKeys: [
      {
        columns: ['product_id'],
        referencedSchema: 'public',
        referencedTable: 'products',
        referencedColumns: ['id'],
      },
    ],
  },
];

describe('relational projection schema and catalog validation', () => {
  it('accepts a bounded version 1 projection and validates its catalog path', () => {
    const config = projectionConfigSchema.parse(input);
    expect(
      validateProjectionCatalog(config, catalog, [
        { name: 'name', type: 'string' },
        { name: 'stock', type: 'int64' },
      ]),
    ).toEqual([]);
    expect(discoverCatalogRelationships(catalog, config.root)).toEqual([
      {
        from: 'public.inventory',
        to: 'public.products',
        columns: ['product_id'],
        referencedColumns: ['id'],
      },
    ]);
  });

  it('rejects cycles, unknown paths, duplicate targets and id overrides', () => {
    const invalid = structuredClone(input) as Record<string, unknown>;
    invalid.relations = [
      {
        ...input.relations[0],
        from: { relation: 'later', columns: ['id'] },
      },
    ];
    invalid.fields = [
      { path: 'missing.value', targetField: 'id', op: 'identity' },
      { path: 'root.name', targetField: 'id', op: 'identity' },
    ];
    const result = projectionConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Relation must reference root or an earlier relation',
        'Field path references an unknown relation',
        'The generated id cannot be overridden',
        'Target fields must be unique',
      ]),
    );
  });

  it('requires reconcile-only mode when a reliable cursor key is absent', () => {
    const config = projectionConfigSchema.parse(input);
    const brokenCatalog = structuredClone(catalog);
    brokenCatalog[1]!.primaryKey = [];
    expect(
      validateProjectionCatalog(config, brokenCatalog, [
        { name: 'name', type: 'string' },
        { name: 'stock', type: 'int64' },
      ]),
    ).toContainEqual(
      expect.objectContaining({
        code: 'CURSOR_UNSUPPORTED',
        path: 'relations.0.changeTracking.key',
      }),
    );
  });

  it('rejects unmapped targets and incompatible identity source types', () => {
    const config = projectionConfigSchema.parse({
      ...input,
      fields: [{ path: 'root.id', targetField: 'name', op: 'identity' }],
    });
    expect(
      validateProjectionCatalog(config, catalog, [
        { name: 'name', type: 'string' },
        { name: 'stock', type: 'int64' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_SOURCE_TYPE' }),
        expect.objectContaining({
          code: 'UNMAPPED_TARGET_FIELD',
          path: 'mapping.stock',
        }),
      ]),
    );
  });
});

describe('projection reconciliation approvals', () => {
  const binding = {
    runId: '11111111-1111-4111-8111-111111111111',
    projectionVersionId: '22222222-2222-4222-8222-222222222222',
    activeIndexGenerationId: '33333333-3333-4333-8333-333333333333',
    candidateSetDigest: 'a'.repeat(64),
    expectedCount: 2,
    expiresAt: '2026-10-23T12:00:00.000Z',
  };

  it('creates an order-independent immutable candidate digest', () => {
    const candidates = [
      { rootKeyHmac: 'b', documentId: 'doc-b', reason: 'ROOT_NOT_ELIGIBLE' },
      { rootKeyHmac: 'a', documentId: 'doc-a', reason: 'ROOT_NOT_FOUND' },
    ];
    expect(projectionCandidateSetDigest(candidates)).toBe(
      projectionCandidateSetDigest([...candidates].reverse()),
    );
    expect(
      projectionCandidateSetDigest([
        ...candidates.slice(0, 1),
        { ...candidates[1]!, documentId: 'changed' },
      ]),
    ).not.toBe(projectionCandidateSetDigest(candidates));
  });

  it('binds approval to version, generation, candidate count and expiry', () => {
    const key = Buffer.alloc(32, 7);
    const token = projectionReconcileToken(binding, key);
    expect(
      projectionReconcileConfirmRequestSchema.parse({
        token,
        expectedCount: 2,
      }),
    ).toEqual({ token, expectedCount: 2 });
    expect(projectionReconcileTokenHash(token)).toHaveLength(64);
    expect(
      projectionReconcileToken({ ...binding, expectedCount: 3 }, key),
    ).not.toBe(token);
    expect(
      projectionReconcileToken(
        {
          ...binding,
          activeIndexGenerationId: '44444444-4444-4444-8444-444444444444',
        },
        key,
      ),
    ).not.toBe(token);
  });

  it('denies deletion after a partial scan or expired approval', () => {
    const completeRun = {
      status: 'AWAITING_CONFIRMATION',
      complete: true,
      expectedCount: 2,
      actualCount: 2,
      candidateSetDigest: 'b'.repeat(64),
      actualCandidateSetDigest: 'b'.repeat(64),
      expiresAt: new Date('2026-10-23T12:30:00.000Z'),
      now: new Date('2026-10-23T12:00:00.000Z'),
    };
    expect(projectionReconciliationCanExecute(completeRun)).toBe(true);
    expect(
      projectionReconciliationCanExecute({ ...completeRun, complete: false }),
    ).toBe(false);
    expect(
      projectionReconciliationCanExecute({
        ...completeRun,
        status: 'INVALID',
      }),
    ).toBe(false);
    expect(
      projectionReconciliationCanExecute({
        ...completeRun,
        now: new Date('2026-10-23T12:31:00.000Z'),
      }),
    ).toBe(false);
    expect(
      projectionReconciliationCanExecute({
        ...completeRun,
        actualCandidateSetDigest: 'c'.repeat(64),
      }),
    ).toBe(false);
  });

  it('schedules reconciliation without bypassing active or unexpired runs', () => {
    const now = new Date('2026-10-23T12:00:00.000Z');
    expect(projectionReconciliationDue({ reconcileHours: 24, now })).toBe(true);
    expect(
      projectionReconciliationDue({
        reconcileHours: 24,
        now,
        latest: {
          status: 'SCANNING',
          createdAt: new Date('2026-10-21T12:00:00.000Z'),
          expiresAt: null,
        },
      }),
    ).toBe(false);
    expect(
      projectionReconciliationDue({
        reconcileHours: 24,
        now,
        latest: {
          status: 'AWAITING_CONFIRMATION',
          createdAt: new Date('2026-10-21T12:00:00.000Z'),
          expiresAt: new Date('2026-10-23T12:30:00.000Z'),
        },
      }),
    ).toBe(false);
    expect(
      projectionReconciliationDue({
        reconcileHours: 24,
        now,
        latest: {
          status: 'COMPLETE',
          createdAt: new Date('2026-10-22T11:59:59.000Z'),
          expiresAt: null,
        },
      }),
    ).toBe(true);
  });
});

describe('relational projection SQL compiler', () => {
  const config: ProjectionConfig = projectionConfigSchema.parse(input);

  it('quotes only validated identifiers and parameterizes all values', () => {
    expect(() => quotePostgresIdentifier('products; DROP TABLE users')).toThrow(
      'Unsafe PostgreSQL identifier',
    );
    expect(() => quotePostgresIdentifier('x" FROM secrets --')).toThrow(
      'Unsafe PostgreSQL identifier',
    );
    const root = compileRootPageQuery(config, "1' OR TRUE --");
    expect(root.text).not.toContain("1' OR TRUE");
    expect(root.values).toEqual(["1' OR TRUE --", 100]);
    const relation = compileRelationFetchQuery(
      config.relations[0]!,
      ['quantity'],
      [["1'); DELETE FROM products; --"]],
    );
    expect(relation.text).not.toContain('DELETE FROM');
    expect(relation.values[0]).toEqual(["1'); DELETE FROM products; --"]);
    expect(relation.values).toContain(true);
    expect(compileExplainQuery(root).text).toMatch(
      /^EXPLAIN \(FORMAT JSON\) SELECT/,
    );
  });

  it('fails explain admission closed and applies row and cost limits', () => {
    expect(
      assessExplainPlan(
        [
          {
            Plan: {
              'Node Type': 'Seq Scan',
              'Total Cost': 12,
              'Plan Rows': 20,
            },
          },
        ],
        {
          maxTotalCost: 100,
          maxPlanRows: 100,
        },
      ),
    ).toEqual({ accepted: true, reasons: [] });
    expect(
      assessExplainPlan(
        [
          {
            Plan: {
              'Node Type': 'Seq Scan',
              'Total Cost': 120,
              'Plan Rows': 200,
            },
          },
        ],
        {
          maxTotalCost: 100,
          maxPlanRows: 100,
        },
      ).accepted,
    ).toBe(false);
    expect(
      assessExplainPlan({}, { maxTotalCost: 100, maxPlanRows: 100 }),
    ).toEqual({
      accepted: false,
      reasons: ['EXPLAIN result has no plan'],
    });
  });
});

describe('relational projection deterministic primitives', () => {
  it('requires explicit eventual-consistency acceptance for publication', () => {
    const versionId = '68ea34f4-059d-4eae-a78b-3aee7c0c6e08';
    expect(
      projectionPublishRequestSchema.safeParse({
        versionId,
        eventualConsistencyAccepted: false,
      }).success,
    ).toBe(false);
    expect(
      projectionPublishRequestSchema.parse({
        versionId,
        eventualConsistencyAccepted: true,
      }),
    ).toEqual({ versionId, eventualConsistencyAccepted: true });
  });

  it('composes the same deterministic document and state used by preview and snapshot', () => {
    const config = projectionConfigSchema.parse(input);
    const rootRows = [{ id: 7, name: 'Desk', deleted_at: null }];
    const rootKey = '[7]';
    const rowsByRelation = new Map([
      ['root', new Map([[rootKey, rootRows]])],
      [
        'inventory',
        new Map([
          [
            rootKey,
            [
              { id: 1, product_id: 7, quantity: 2 },
              { id: 2, product_id: 7, quantity: 3 },
            ],
          ],
        ]),
      ],
    ]);
    const result = composeProjectionDocuments(config, rootRows, rowsByRelation);
    expect(result.diagnostics).toEqual([]);
    expect(result.documents).toEqual([
      {
        id: projectionDocumentId([7], 'product-'),
        name: 'Desk',
        stock: 5,
      },
    ]);
    expect(result.states).toEqual([
      expect.objectContaining({
        rootKeyParts: [7],
        rootKeyHash: rootKey,
        terminalState: 'COMPOSED',
        canonicalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(projectionDependencyKeys(config, rowsByRelation, rootKey)).toEqual([
      { relationId: 'inventory', keyParts: [1] },
      { relationId: 'inventory', keyParts: [2] },
    ]);
  });

  it('keeps typed keys collision-free and deterministic', () => {
    expect(encodeCanonicalKey([1])).not.toEqual(encodeCanonicalKey(['1']));
    expect(encodeCanonicalKey([1])).not.toEqual(encodeCanonicalKey([1n]));
    expect(projectionDocumentId([1], 'product-')).toBe(
      projectionDocumentId([1], 'product-'),
    );
    expect(protectedKeyHmac([1], Buffer.alloc(32, 4))).not.toBe(
      protectedKeyHmac(['1'], Buffer.alloc(32, 4)),
    );
    const key = ['unit-1', 42, true] as const;
    expect(decodeCanonicalKey(encodeCanonicalKey(key))).toEqual(key);
    expect(() => decodeCanonicalKey(Buffer.from([2, 1]))).toThrow(
      'Unsupported canonical key version',
    );
  });

  it('hashes configuration canonically and never silently truncates arrays', () => {
    const config = projectionConfigSchema.parse(input);
    const reordered = { ...config, sync: { ...config.sync } };
    expect(projectionConfigHash(config)).toBe(projectionConfigHash(reordered));
    expect(projectionSchemaFingerprint(config, catalog)).toHaveLength(64);
    const driftedCatalog = structuredClone(catalog);
    driftedCatalog[0]!.columns[0]!.dataType = 'text';
    expect(projectionSchemaFingerprint(config, driftedCatalog)).not.toBe(
      projectionSchemaFingerprint(config, catalog),
    );
    expect(uniqueSortedArray(['b', 'a', 'b'], 2)).toEqual(['a', 'b']);
    expect(() => uniqueSortedArray(['a', 'b', 'c'], 2)).toThrow('FANOUT_LIMIT');
    expect(aggregateProjectionValues('sum', [2, null, 3])).toBe(5);
    expect(aggregateProjectionValues('count', [2, null, 3])).toBe(2);
    expect(aggregateProjectionValues('min', ['b', 'a'])).toBe('a');
    expect(castProjectionScalar('42', 'int64')).toBe(42);
    expect(() => castProjectionScalar('1 OR TRUE', 'int64')).toThrow(
      'INVALID_TYPE_CAST',
    );
    expect(concatProjectionScalars(['a', 2, true], '-', 20)).toBe('a-2-true');
    expect(() => concatProjectionScalars(['too', 'long'], '-', 4)).toThrow(
      'DOCUMENT_TOO_LARGE',
    );
    const ordered = selectOrderedProjectionValues(
      [
        { id: 2, rank: 1 },
        { id: 1, rank: 1 },
        { id: 3, rank: 2 },
      ],
      (value) => [value.rank, value.id],
      ['asc', 'asc'],
      2,
      true,
    );
    expect(ordered.map((value) => value.id)).toEqual([1, 2]);
    expect(() =>
      selectOrderedProjectionValues(
        [1, 2],
        (value) => [value],
        ['asc'],
        1,
        false,
      ),
    ).toThrow('FANOUT_LIMIT');
    expect(() => assertProjectionVersionEditable('DRAFT')).not.toThrow();
    expect(() => assertProjectionVersionEditable('VALIDATED')).toThrow(
      'Projection versions are immutable after validation',
    );
    expect(() => assertProjectionVersionEditable('PUBLISHED')).toThrow(
      'Projection versions are immutable after validation',
    );
  });
});
