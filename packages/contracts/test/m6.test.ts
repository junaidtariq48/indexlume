import { describe, expect, it } from 'vitest';

import {
  analyticsQuerySchema,
  auditQuerySchema,
  createSearchPresetRequestSchema,
} from '../src/index.js';

describe('M6 operations contracts', () => {
  it('accepts only validated Search Studio settings in presets', () => {
    expect(
      createSearchPresetRequestSchema.safeParse({
        name: 'In-stock keyboards',
        settings: {
          q: 'keyboard',
          queryBy: ['title'],
          filterBy: [{ field: 'in_stock', operator: 'eq', value: true }],
          facetBy: ['category'],
          sortBy: [{ field: 'price', direction: 'asc' }],
          page: 1,
          perPage: 20,
        },
      }).success,
    ).toBe(true);
    expect(
      createSearchPresetRequestSchema.safeParse({
        name: 'Unsafe',
        settings: { q: '*', queryBy: ['title'], filter_by: 'price:>0' },
      }).success,
    ).toBe(false);
  });

  it('validates date ranges and bounded audit pagination inputs', () => {
    expect(
      analyticsQuerySchema.safeParse({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(analyticsQuerySchema.safeParse({ from: 'last week' }).success).toBe(
      false,
    );
    expect(auditQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(auditQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
