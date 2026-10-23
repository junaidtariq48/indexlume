import { describe, expect, it } from 'vitest';

import {
  createSearchKeyRequestSchema,
  publicSearchRequestSchema,
} from '../src/index.js';

describe('M5 public search contracts', () => {
  it('accepts only the constrained structured search shape', () => {
    expect(
      publicSearchRequestSchema.safeParse({
        q: 'keyboard',
        filter: [{ field: 'in_stock', operator: 'eq', value: true }],
        sort: [{ field: 'price', direction: 'asc' }],
        facets: ['category'],
        page: 1,
        perPage: 10,
      }).success,
    ).toBe(true);
    expect(
      publicSearchRequestSchema.safeParse({
        q: '*',
        filter_by: 'price:>0',
      }).success,
    ).toBe(false);
  });

  it('blocks oversized result windows and invalid key limits', () => {
    expect(
      publicSearchRequestSchema.safeParse({ q: '*', page: 101, perPage: 100 })
        .success,
    ).toBe(false);
    expect(
      createSearchKeyRequestSchema.safeParse({
        label: 'Website',
        rateLimitOverride: 0,
      }).success,
    ).toBe(false);
  });
});
