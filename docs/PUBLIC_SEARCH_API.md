# Public search API

Public search is a read-only, project-scoped proxy. Create a search key in **Settings → Search API keys** and copy it when it is shown; only its prefix and keyed hash are retained afterward.

## Endpoint

`POST /api/v1/search/v1/:projectPublicId/:indexSlug`

Send `Authorization: Bearer osc_sk_…` and `Content-Type: application/json` headers. The accepted JSON body is:

```json
{
  "q": "keyboard",
  "filter": [{ "field": "in_stock", "operator": "eq", "value": true }],
  "sort": [{ "field": "price", "direction": "asc" }],
  "facets": ["category"],
  "page": 1,
  "perPage": 10
}
```

`q` is limited to 512 characters, `perPage` to 100, and the result window to 10,000 records. Filter, sort, and facet fields must have the corresponding capability in the saved index mapping. Unknown properties and raw Typesense parameters are rejected. Returned documents are limited to mapped fields. A key can access only indexes belonging to its project.

The response shape is `{hits:[{id,document,highlights}],found,page,perPage,facets,requestMs}`. Rate-limited requests return `429` with `Retry-After`; invalid or revoked keys return `401`.

## JavaScript/TypeScript

```ts
import { SearchClient } from '@osc/ts-client';

const client = new SearchClient({
  baseUrl: 'https://search.example.com',
  projectPublicId: '<public-project-id>',
  searchKey: '<search-key>',
});

const results = await client.search('products', {
  q: 'keyboard',
  filter: [{ field: 'in_stock', operator: 'eq', value: true }],
  page: 1,
  perPage: 10,
});
```

Do not commit search keys. For server-rendered applications, keep them in environment configuration. For browser clients, treat them as revocable public credentials with read-only scope and a rate limit.

## PHP

The dependency-free example is in `examples/php-public-search/index.php`:

```sh
OSC_BASE_URL=https://search.example.com \
OSC_PROJECT_PUBLIC_ID=<public-project-id> \
OSC_SEARCH_KEY=<search-key> \
php examples/php-public-search/index.php products keyboard
```
