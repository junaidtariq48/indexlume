const apiUrl = process.env.M2_API_URL ?? 'http://localhost:3301/api/v1';
const appOrigin = process.env.M2_APP_ORIGIN ?? 'http://localhost:3300';
const typesenseApiKey = process.env.M2_TYPESENSE_API_KEY;
if (!typesenseApiKey) {
  throw new Error('M2_TYPESENSE_API_KEY is required');
}

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
const workspaces = await request('/workspaces', { headers: ownerHeaders });
const workspace = workspaces.body.data.find(
  (item) => item.slug === 'm1-workspace',
);
if (!workspace) throw new Error('M1 smoke workspace is required');

const connections = await request(
  `/workspaces/${workspace.id}/typesense-connections`,
  { headers: ownerHeaders },
);
let connection = connections.body.data.find(
  (item) => item.name === 'M2 External Typesense',
);
if (!connection) {
  const created = await request(
    `/workspaces/${workspace.id}/typesense-connections`,
    {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        name: 'M2 External Typesense',
        mode: 'EXTERNAL',
        endpoint: 'http://typesense:8108',
        apiKey: typesenseApiKey,
        tlsPolicy: 'ALLOW_INSECURE',
      }),
    },
    201,
  );
  if (
    created.text.includes(typesenseApiKey) ||
    created.text.includes('encryptedApiKey')
  ) {
    throw new Error('Connection response leaked key material');
  }
  connection = created.body;
}
await request(
  `/typesense-connections/${connection.id}/test`,
  {
    method: 'POST',
    headers: ownerHeaders,
  },
  201,
);

const projects = await request(`/workspaces/${workspace.id}/projects`, {
  headers: ownerHeaders,
});
let project = projects.body.data.find((item) => item.slug === 'm2-external');
if (!project) {
  project = (
    await request(
      `/workspaces/${workspace.id}/projects`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          name: 'M2 External',
          slug: 'm2-external',
          typesenseConnectionId: connection.id,
        }),
      },
      201,
    )
  ).body;
} else if (project.typesenseConnectionId !== connection.id) {
  project = (
    await request(`/projects/${project.id}`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ typesenseConnectionId: connection.id }),
    })
  ).body;
}

const indexes = await request(`/projects/${project.id}/indexes`, {
  headers: ownerHeaders,
});
let index = indexes.body.data.find((item) => item.slug === 'demo-products');
if (!index) {
  index = (
    await request(
      `/projects/${project.id}/indexes`,
      {
        method: 'POST',
        headers: ownerHeaders,
        body: JSON.stringify({
          name: 'Demo products',
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
if (index.alias !== `osc_${project.id}_demo-products`) {
  throw new Error('Index alias does not match the documented naming rule');
}

const search = await request(
  `/indexes/${index.id}/playground/search`,
  {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      q: 'keyboard',
      queryBy: ['title', 'category'],
      page: 1,
      perPage: 20,
    }),
  },
  201,
);
if (search.body.found !== 2) throw new Error('Expected two keyboard fixtures');

const viewerHeaders = await login(
  'm1-viewer@example.test',
  'm1-viewer-password-123',
);
await request(`/projects/${project.id}/indexes`, { headers: viewerHeaders });
await request(
  `/projects/${project.id}/indexes`,
  {
    method: 'POST',
    headers: viewerHeaders,
    body: JSON.stringify({
      name: 'Forbidden',
      slug: 'forbidden',
      fields: [{ name: 'title', type: 'string', searchable: true }],
    }),
  },
  403,
);

console.log(
  'M2 smoke passed: external connection, redaction, alias-backed fixture index, search, and viewer permissions.',
);
