const apiRoot = process.env.M6_API_ROOT ?? 'http://localhost:3301';
const apiUrl = `${apiRoot}/api/v1`;
const appOrigin = process.env.M6_APP_ORIGIN ?? 'http://localhost:3300';

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
const viewerHeaders = await login(
  'm1-viewer@example.test',
  'm1-viewer-password-123',
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
const project = projects.find((item) => item.slug === 'm5-isolated');
if (!project) throw new Error('M5 isolated project is required');
const index = (
  await request(`/projects/${project.id}/indexes`, { headers: ownerHeaders })
).body.data.find((item) => item.slug === 'demo-products');
if (!index) throw new Error('M5 demo index is required');

const zeroProject = (
  await request(
    `/workspaces/${workspace.id}/projects`,
    {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        name: 'M6 zero traffic fixture',
        slug: `m6-zero-${Date.now().toString(36)}`,
      }),
    },
    201,
  )
).body;
const zeroAnalytics = await request(`/projects/${zeroProject.id}/analytics`, {
  headers: ownerHeaders,
});
if (
  zeroAnalytics.body.hasData !== false ||
  zeroAnalytics.body.summary.requests !== 0 ||
  zeroAnalytics.body.summary.p50Ms !== null ||
  zeroAnalytics.body.summary.p95Ms !== null
) {
  throw new Error(
    `Zero-traffic analytics were not empty: ${zeroAnalytics.text}`,
  );
}
await request(`/projects/${zeroProject.id}`, {
  method: 'DELETE',
  headers: ownerHeaders,
});

const searchKey = (
  await request(
    `/projects/${project.id}/search-keys`,
    {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ label: `M6 analytics ${Date.now()}` }),
    },
    201,
  )
).body;
for (const q of ['keyboard', 'mouse', '*']) {
  await request(
    `/search/v1/${project.publicId}/${index.slug}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${searchKey.secret}` },
      body: JSON.stringify({ q, page: 1, perPage: 10 }),
    },
    201,
  );
}
const analytics = await request(`/projects/${project.id}/analytics`, {
  headers: ownerHeaders,
});
if (
  !analytics.body.hasData ||
  analytics.body.summary.requests < 3 ||
  analytics.body.summary.p50Ms === null ||
  analytics.body.summary.p95Ms === null ||
  analytics.body.privacy.queryTermsCollected !== false
) {
  throw new Error(`Collected analytics were incomplete: ${analytics.text}`);
}
await request(
  `/projects/${project.id}/analytics?from=2026-01-01T00%3A00%3A00.000Z&to=2026-10-22T00%3A00%3A00.000Z`,
  { headers: ownerHeaders },
  400,
);

const presetName = `M6 smoke ${Date.now()}`;
const createdPreset = (
  await request(
    `/indexes/${index.id}/presets`,
    {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        name: presetName,
        settings: {
          q: 'keyboard',
          queryBy: ['title'],
          filterBy: [{ field: 'in_stock', operator: 'eq', value: true }],
          facetBy: ['category'],
          sortBy: [{ field: 'price', direction: 'asc' }],
          page: 1,
          perPage: 20,
        },
      }),
    },
    201,
  )
).body;
const listed = await request(`/indexes/${index.id}/presets`, {
  headers: viewerHeaders,
});
if (!listed.body.data.some((item) => item.id === createdPreset.id)) {
  throw new Error('Viewer could not read the created preset');
}
await request(
  `/indexes/${index.id}/presets`,
  {
    method: 'POST',
    headers: viewerHeaders,
    body: JSON.stringify({
      name: 'Forbidden',
      settings: createdPreset.settings,
    }),
  },
  403,
);
await request(
  `/indexes/${index.id}/presets`,
  {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      name: 'Unsafe raw syntax',
      settings: { q: '*', queryBy: ['title'], filter_by: 'price:>0' },
    }),
  },
  400,
);
await request(`/presets/${createdPreset.id}`, {
  method: 'PATCH',
  headers: ownerHeaders,
  body: JSON.stringify({ name: `${presetName} updated` }),
});
const audit = await request(`/projects/${project.id}/audit?limit=100`, {
  headers: ownerHeaders,
});
for (const action of [
  'search_api_key.created',
  'search_preset.created',
  'search_preset.updated',
]) {
  if (!audit.body.data.some((item) => item.action === action)) {
    throw new Error(`Audit feed is missing ${action}`);
  }
}
await request(`/presets/${createdPreset.id}`, {
  method: 'DELETE',
  headers: ownerHeaders,
});
await request(
  `/search-keys/${searchKey.id}/revoke`,
  {
    method: 'POST',
    headers: ownerHeaders,
  },
  201,
);

console.log(
  'M6 smoke passed: zero-data analytics, real query metrics, percentile estimates, bounded ranges, preset RBAC/validation/CRUD, and project audit trail.',
);
