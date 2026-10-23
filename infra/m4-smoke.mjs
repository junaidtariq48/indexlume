import { execFileSync } from 'node:child_process';

const apiUrl = process.env.M4_API_URL ?? 'http://localhost:3301/api/v1';
const appOrigin = process.env.M4_APP_ORIGIN ?? 'http://localhost:3300';

execFileSync(
  'docker',
  ['compose', '--profile', 'test', 'up', '-d', 'source-postgres'],
  { stdio: 'pipe' },
);

function fixtureSql(sql) {
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'source-postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'connector_admin',
      '-d',
      'connector_fixture',
      '-c',
      sql,
    ],
    { stdio: 'pipe' },
  );
}

function controlSql(sql) {
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'open_search_console',
      '-d',
      'open_search_console',
      '-c',
      sql,
    ],
    { stdio: 'pipe' },
  );
}

async function request(path, init = {}, expected = 200) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...init.headers },
  });
  const text = await response.text();
  if (response.status !== expected)
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${expected}, got ${response.status}: ${text}`,
    );
  return text ? JSON.parse(text) : undefined;
}

async function login(email, password) {
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 201) throw new Error(`Login failed for ${email}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Login did not set a cookie');
  return { cookie, origin: appOrigin };
}

async function waitForRun(runId, headers) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = await request(`/runs/${runId}`, { headers });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function search(indexId, q, headers) {
  return request(
    `/indexes/${indexId}/playground/search`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        q,
        queryBy: ['name'],
        page: 1,
        perPage: 20,
      }),
    },
    201,
  );
}

fixtureSql(
  `ALTER TABLE IF EXISTS public.products_fixture RENAME TO products;
   TRUNCATE public.products;
   INSERT INTO public.products (id, name, category, price, updated_at, deleted_at) VALUES
   ('pg-001', 'PostgreSQL Keyboard', 'keyboards', 129, '2020-01-01T10:00:00Z', NULL),
   ('pg-002', 'PostgreSQL Mouse', 'mice', 69, '2020-01-01T10:00:00Z', NULL),
   ('pg-003', 'PostgreSQL Monitor', 'monitors', 399, '2020-01-01T10:01:00Z', NULL);
   GRANT SELECT ON public.products TO connector_reader;`,
);

const headers = await login('m1-owner@example.test', 'm1-owner-password-123');
const workspaces = await request('/workspaces', { headers });
const workspace = workspaces.data.find((item) => item.slug === 'm1-workspace');
const projects = await request(`/workspaces/${workspace.id}/projects`, {
  headers,
});
const project = projects.data.find((item) => item.slug === 'm2-external');
if (!project) throw new Error('Run M2 smoke before M4 smoke');

const suffix = Date.now().toString(36);
const index = await request(
  `/projects/${project.id}/indexes`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `M4 PostgreSQL ${suffix}`,
      slug: `m4-postgres-${suffix}`,
      fields: [
        {
          name: 'name',
          type: 'string',
          searchable: true,
          facet: false,
          sort: false,
          optional: false,
        },
        {
          name: 'category',
          type: 'string',
          searchable: false,
          facet: true,
          sort: false,
          optional: false,
        },
        {
          name: 'price',
          type: 'float',
          searchable: false,
          facet: false,
          sort: true,
          optional: false,
        },
      ],
      withDemoData: false,
    }),
  },
  201,
);

const source = await request(
  `/projects/${project.id}/sources`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `M4 fixture ${suffix}`,
      connectionUrl:
        'postgresql://connector_reader:connector-read-only@source-postgres:5432/connector_fixture',
      tlsPolicy: 'ALLOW_INSECURE',
    }),
  },
  201,
);
if (
  'connectionUrl' in source ||
  'encryptedConfig' in source ||
  JSON.stringify(source).includes('connector-read-only')
) {
  throw new Error('PostgreSQL credential material was returned by the API');
}
const tested = await request(
  `/sources/${source.id}/test`,
  { method: 'POST', headers },
  201,
);
if (!tested.ok) throw new Error('Saved PostgreSQL connection test failed');
const discovered = await request(`/sources/${source.id}/datasets`, { headers });
const dataset = discovered.data.find(
  (item) => item.schemaName === 'public' && item.tableName === 'products',
);
if (!dataset) throw new Error('Allowlisted fixture dataset was not discovered');
const fields = ['id', 'name', 'category', 'price', 'updated_at', 'deleted_at'];
const preview = await request(
  `/sources/${source.id}/preview`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaName: 'public',
      tableName: 'products',
      fields,
      primaryKeyField: 'id',
    }),
  },
  201,
);
if (preview.rows.length !== 3 || preview.rows.length > 20)
  throw new Error('Bounded PostgreSQL preview is incorrect');
await request(`/sources/${source.id}`, {
  method: 'PATCH',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    schemaName: 'public',
    tableName: 'products',
    primaryKeyField: 'id',
    updatedAtField: 'updated_at',
    deletedAtField: 'deleted_at',
    fieldAllowlist: fields,
    searchIndexId: index.id,
    intervalMinutes: 60,
  }),
});

const rebuilt = await request(
  `/indexes/${index.id}/rebuild`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: source.id }),
  },
  201,
);
const rebuiltRun = await waitForRun(rebuilt.id, headers);
if (rebuiltRun.status !== 'SUCCEEDED' || rebuiltRun.succeeded !== 3)
  throw new Error(
    `Initial keyset snapshot failed: ${JSON.stringify(rebuiltRun)}`,
  );

fixtureSql(
  `INSERT INTO public.products (id, name, category, price, updated_at) VALUES
   ('pg-010', 'Tied Alpha', 'ties', 10, '2020-01-01T11:00:00Z'),
   ('pg-011', 'Tied Beta', 'ties', 11, '2020-01-01T11:00:00Z');`,
);
const tiedRun = await waitForRun(
  (await request(`/indexes/${index.id}/sync`, { method: 'POST', headers }, 201))
    .id,
  headers,
);
if (tiedRun.status !== 'SUCCEEDED') throw new Error('Tied cursor sync failed');
if ((await search(index.id, 'Tied', headers)).found !== 2)
  throw new Error('Stable primary-key tie-breaker lost an inserted row');

fixtureSql(
  `UPDATE public.products SET name = 'Updated Keyboard', updated_at = '2020-01-01T11:01:00Z' WHERE id = 'pg-001';
   UPDATE public.products SET deleted_at = '2020-01-01T11:02:00Z', updated_at = '2020-01-01T11:02:00Z' WHERE id = 'pg-002';`,
);
const changedRun = await waitForRun(
  (await request(`/indexes/${index.id}/sync`, { method: 'POST', headers }, 201))
    .id,
  headers,
);
if (changedRun.status !== 'SUCCEEDED' || changedRun.deleted < 1)
  throw new Error('Update/soft-delete sync failed');
if ((await search(index.id, 'Updated Keyboard', headers)).found !== 1)
  throw new Error('Updated row is not searchable');
if ((await search(index.id, 'Mouse', headers)).found !== 0)
  throw new Error('Soft-deleted row remains searchable');

fixtureSql(`DELETE FROM public.products WHERE id = 'pg-003';`);
const reconcileStart = await request(
  `/indexes/${index.id}/reconcile/preview`,
  { method: 'POST', headers },
  201,
);
if ((await waitForRun(reconcileStart.run.id, headers)).status !== 'SUCCEEDED')
  throw new Error('Complete reconciliation scan failed');
const reconciliation = await request(
  `/runs/${reconcileStart.run.id}/reconciliation`,
  { headers },
);
if (!reconciliation.complete || !reconciliation.missingIds.includes('pg-003'))
  throw new Error('Hard-delete reconciliation preview is incorrect');
const execution = await request(
  `/indexes/${index.id}/reconcile/execute`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ token: reconcileStart.token }),
  },
  201,
);
if ((await waitForRun(execution.id, headers)).status !== 'SUCCEEDED')
  throw new Error('Reconciliation execution failed');
if ((await search(index.id, 'Monitor', headers)).found !== 0)
  throw new Error('Reconciled hard delete remains searchable');

fixtureSql(
  `INSERT INTO public.products (id, name, category, price, updated_at) VALUES
   ('pg-fail', 'Must Survive Failed Scan', 'guardrail', 1, '2020-01-01T11:03:00Z');`,
);
await waitForRun(
  (await request(`/indexes/${index.id}/sync`, { method: 'POST', headers }, 201))
    .id,
  headers,
);
fixtureSql(`ALTER TABLE public.products RENAME TO products_fixture;`);
const failedStart = await request(
  `/indexes/${index.id}/reconcile/preview`,
  { method: 'POST', headers },
  201,
);
const failedRun = await waitForRun(failedStart.run.id, headers);
const failedPreview = await request(
  `/runs/${failedStart.run.id}/reconciliation`,
  { headers },
);
if (failedRun.status !== 'FAILED' || failedPreview.complete)
  throw new Error('Incomplete reconciliation scan was not marked unsafe');
await request(
  `/indexes/${index.id}/reconcile/execute`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ token: failedStart.token }),
  },
  400,
);
if ((await search(index.id, 'Must Survive Failed Scan', headers)).found !== 1)
  throw new Error('Incomplete reconciliation deleted an indexed document');
fixtureSql(`ALTER TABLE public.products_fixture RENAME TO products;`);

controlSql(
  `UPDATE scheduled_syncs SET next_run_at = now() WHERE search_index_id = '${index.id}'::uuid;`,
);
let scheduledRun;
for (let attempt = 0; attempt < 140; attempt += 1) {
  const runs = await request(`/indexes/${index.id}/runs`, { headers });
  scheduledRun = runs.data.find(
    (run) => run.trigger === 'SCHEDULED_POSTGRES_SYNC',
  );
  if (scheduledRun) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!scheduledRun) throw new Error('Due schedule did not enqueue a sync run');
if ((await waitForRun(scheduledRun.id, headers)).status !== 'SUCCEEDED')
  throw new Error('Scheduled synchronization did not succeed');

const viewerHeaders = await login(
  'm1-viewer@example.test',
  'm1-viewer-password-123',
);
await request(`/projects/${project.id}/sources`, { headers: viewerHeaders });
await request(
  `/projects/${project.id}/sources`,
  {
    method: 'POST',
    headers: { ...viewerHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Forbidden source',
      connectionUrl:
        'postgresql://connector_reader:connector-read-only@source-postgres:5432/connector_fixture',
      tlsPolicy: 'ALLOW_INSECURE',
    }),
  },
  403,
);

console.log(
  'M4 smoke passed: read-only discovery/preview, keyset snapshot, tied-cursor inserts, update, soft delete, hard-delete reconciliation, incomplete-scan deletion guardrail, scheduled sync, credential redaction, and viewer authorization.',
);
