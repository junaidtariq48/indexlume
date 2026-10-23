import { describe, expect, it, vi } from 'vitest';

import { SearchClient, SearchClientError } from '../src/index.js';

describe('SearchClient', () => {
  it('calls only the constrained public search endpoint', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ hits: [], found: 0, page: 1, perPage: 10 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const client = new SearchClient({
      baseUrl: 'https://search.example/',
      projectPublicId: 'public-project',
      searchKey: 'osc_sk_secret',
      fetch: request,
    });

    await client.search('products', { q: 'keyboard' });

    expect(request).toHaveBeenCalledWith(
      'https://search.example/api/v1/search/v1/public-project/products',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ q: 'keyboard' }),
      }),
    );
  });

  it('returns a typed error without leaking response internals', async () => {
    const client = new SearchClient({
      baseUrl: 'https://search.example',
      projectPublicId: 'project',
      searchKey: 'osc_sk_revoked',
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Search key is invalid or revoked',
              requestId: 'r1',
            },
          }),
          { status: 401 },
        ),
      ),
    });

    await expect(client.search('products', { q: '' })).rejects.toEqual(
      new SearchClientError('Search key is invalid or revoked', 401, 'r1'),
    );
  });
});
