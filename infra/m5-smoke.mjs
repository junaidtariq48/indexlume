import { execFileSync } from 'node:child_process';

const apiRoot = process.env.M5_API_ROOT ?? 'http://localhost:3301';
const apiUrl = `${apiRoot}/api/v1`;
const appOrigin = process.env.M5_APP_ORIGIN ?? 'http://localhost:3300';

async function request(path, init = {}, expected = 200) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${expected}, got ${response.status}: ${text}`,
    );
  }
  return { body: text ? JSON.parse(text) : undefined, response, text };
}

async function login(email, password) {
  const result = await request(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    201,
  );
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Login did not set a session cookie');
  return { cookie, origin: appOrigin };
}

const ownerHeaders = await login(
  'm1-owner@example.test',
  'm1-owner-password-123',
);
const workspace = (
  await request('/workspaces', { headers: ownerHeaders })
).body.data.find((item) => item.slug === 'm1-workspace');
if (!workspace) throw new Error('M1 smoke workspace is required');
const projects = (
  await request(`/workspaces/${workspace.id}/projects`, {
    headers: ownerHeaders,
  })
).body.data;
const projectA = projects.find((item) => item.slug === 'm2-external');
if (!projectA?.typesenseConnectionId) {
  throw new Error('M2 project and Typesense connection are required');
}
const indexA = (
  await request(`/projects/${projectA.id}/indexes`, { headers: ownerHeaders })
).body.data.find((item) => item.slug === 'demo-products');
if (!indexA) throw new Error('M2 demo index is required');

let projectB = projects.find((item) => item.slug === 'm5-isolated');
if (!projectB) {
  projectB = (
    await request(
      `/workspaces/${workspace.id}/projects`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          name: 'M5 Isolated',
          slug: 'm5-isolated',
          typesenseConnectionId: projectA.typesenseConnectionId,
        }),
      },
      201,
    )
  ).body;
}
let indexB = (
  await request(`/projects/${projectB.id}/indexes`, { headers: ownerHeaders })
).body.data.find((item) => item.slug === 'demo-products');
if (!indexB) {
  indexB = (
    await request(
      `/projects/${projectB.id}/indexes`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          name: 'Isolated demo products',
          slug: 'demo-products',
          withDemoData: true,
          defaultSortingField: 'price',
          fields: [
            { name: 'title', type: 'string', searchable: true },
            { name: 'category', type: 'string', searchable: true, facet: true },
            { name: 'price', type: 'float', facet: true, sort: true },
            { name: 'in_stock', type: 'bool', facet: true },
          ],
        }),
      },
      201,
    )
  ).body;
}

const created = await request(
  `/projects/${projectB.id}/search-keys`,
  {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      label: `M5 smoke ${Date.now()}`,
      rateLimitOverride: 20,
    }),
  },
  201,
);
const key = created.body;
if (!/^osc_sk_[A-Za-z0-9_-]{43}$/.test(key.secret)) {
  throw new Error('Created search key has an invalid format');
}
const listed = await request(`/projects/${projectB.id}/search-keys`, {
  headers: ownerHeaders,
});
if (listed.text.includes(key.secret) || listed.text.includes('keyHash')) {
  throw new Error('Search key list leaked secret material');
}
const publicHeaders = { authorization: `Bearer ${key.secret}` };
const publicSearch = await request(
  `/search/v1/${projectB.publicId}/${indexB.slug}`,
  {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({
      q: 'keyboard',
      filter: [{ field: 'in_stock', operator: 'eq', value: true }],
      sort: [{ field: 'price', direction: 'asc' }],
      facets: ['category'],
      page: 1,
      perPage: 10,
    }),
  },
  201,
);
if (publicSearch.body.found !== 2 || publicSearch.body.hits.length !== 2) {
  throw new Error(
    `Public search did not return the fixture results: ${JSON.stringify(publicSearch.body)}`,
  );
}
if (!publicSearch.response.headers.get('ratelimit-remaining')) {
  throw new Error('Public search did not return rate-limit headers');
}
await request(
  `/search/v1/${projectA.publicId}/${indexA.slug}`,
  {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ q: 'keyboard' }),
  },
  401,
);
await request(
  `/search/v1/${projectB.publicId}/${indexB.slug}`,
  {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({
      q: '*',
      filter: [{ field: 'not_allowed', operator: 'eq', value: 'x' }],
    }),
  },
  422,
);
await request(
  `/search/v1/${projectB.publicId}/${indexB.slug}`,
  {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ q: '*', page: 101, perPage: 100 }),
  },
  400,
);

const phpOutput = execFileSync(
  'php',
  ['examples/php-public-search/index.php', indexB.slug, 'keyboard'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OSC_BASE_URL: apiRoot,
      OSC_PROJECT_PUBLIC_ID: projectB.publicId,
      OSC_SEARCH_KEY: key.secret,
    },
    encoding: 'utf8',
  },
);
if (JSON.parse(phpOutput).found !== 2) {
  throw new Error('PHP sample did not complete the public search journey');
}

const viewerHeaders = await login(
  'm1-viewer@example.test',
  'm1-viewer-password-123',
);
await request(`/projects/${projectB.id}/search-keys`, {
  headers: viewerHeaders,
});
await request(
  `/projects/${projectB.id}/search-keys`,
  {
    method: 'POST',
    headers: viewerHeaders,
    body: JSON.stringify({ label: 'Forbidden viewer key' }),
  },
  403,
);

const rateProject = (
  await request(
    `/workspaces/${workspace.id}/projects`,
    {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        name: 'M5 rate-limit fixture',
        slug: `m5-rate-${Date.now().toString(36)}`,
      }),
    },
    201,
  )
).body;
const rateKey = (
  await request(
    `/projects/${rateProject.id}/search-keys`,
    {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        label: 'Rate-limit fixture',
        rateLimitOverride: 2,
      }),
    },
    201,
  )
).body;
const rateHeaders = { authorization: `Bearer ${rateKey.secret}` };
for (let attempt = 0; attempt < 2; attempt += 1) {
  await request(
    `/search/v1/${rateProject.publicId}/missing-index`,
    {
      method: 'POST',
      headers: rateHeaders,
      body: JSON.stringify({ q: '*' }),
    },
    404,
  );
}
const throttled = await request(
  `/search/v1/${rateProject.publicId}/missing-index`,
  {
    method: 'POST',
    headers: rateHeaders,
    body: JSON.stringify({ q: '*' }),
  },
  429,
);
if (!throttled.response.headers.get('retry-after')) {
  throw new Error('Rate-limited response did not include Retry-After');
}
await request(`/projects/${rateProject.id}`, {
  method: 'DELETE',
  headers: ownerHeaders,
});

await request(
  `/search-keys/${key.id}/revoke`,
  { method: 'POST', headers: ownerHeaders },
  201,
);
await request(
  `/search/v1/${projectB.publicId}/${indexB.slug}`,
  {
    method: 'POST',
    headers: publicHeaders,
    body: JSON.stringify({ q: 'keyboard' }),
  },
  401,
);

console.log(
  'M5 smoke passed: one-time keys, public search, project isolation, safe fields, bounded pagination, rate limiting, PHP sample, viewer policy, and immediate revocation.',
);
