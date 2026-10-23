import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { compilePublicFilters } from '../src/public-search/filter-compiler.js';
import {
  hashSearchKey,
  issueSearchKey,
  parseBearerSearchKey,
  searchKeyHashMatches,
} from '../src/public-search/search-key.crypto.js';

const pepper = Buffer.alloc(32, 9).toString('base64');
const fields = [
  {
    name: 'category',
    type: 'string' as const,
    searchable: true,
    facet: true,
    sort: false,
    optional: false,
  },
  {
    name: 'price',
    type: 'float' as const,
    searchable: false,
    facet: true,
    sort: true,
    optional: false,
  },
];

describe('public search key security', () => {
  it('issues high-entropy prefixed keys and compares only keyed hashes', () => {
    const issued = issueSearchKey(pepper);
    expect(issued.secret).toMatch(/^osc_sk_[A-Za-z0-9_-]{43}$/);
    expect(issued.hash).not.toContain(issued.secret);
    expect(
      searchKeyHashMatches(hashSearchKey(issued.secret, pepper), issued.hash),
    ).toBe(true);
    expect(
      searchKeyHashMatches(
        hashSearchKey(`${issued.secret}x`, pepper),
        issued.hash,
      ),
    ).toBe(false);
  });

  it('parses only the documented bearer credential format', () => {
    const issued = issueSearchKey(pepper);
    expect(parseBearerSearchKey(`Bearer ${issued.secret}`)).toBe(issued.secret);
    expect(parseBearerSearchKey(`Basic ${issued.secret}`)).toBe('');
    expect(parseBearerSearchKey('Bearer osc_sk_short')).toBe('');
  });
});

describe('public filter compiler', () => {
  it('escapes strings and compiles allowlisted structured filters', () => {
    expect(
      compilePublicFilters(fields, [
        { field: 'category', operator: 'eq', value: 'key`boards' },
        { field: 'price', operator: 'gte', value: 25 },
      ]),
    ).toBe('category:=`key\\`boards` && price:>=25');
  });

  it('rejects unauthorized fields and invalid operator types', () => {
    expect(() =>
      compilePublicFilters(fields, [
        { field: 'secret', operator: 'eq', value: 'x' },
      ]),
    ).toThrow(UnprocessableEntityException);
    expect(() =>
      compilePublicFilters(fields, [
        { field: 'category', operator: 'gt', value: 'x' },
      ]),
    ).toThrow(UnprocessableEntityException);
  });
});
