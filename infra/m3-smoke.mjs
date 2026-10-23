const apiUrl = process.env.M3_API_URL ?? 'http://localhost:3301/api/v1';
const appOrigin = process.env.M3_APP_ORIGIN ?? 'http://localhost:3300';

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
const login = await fetch(`${apiUrl}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'm1-owner@example.test',
    password: 'm1-owner-password-123',
  }),
});
if (login.status !== 201) throw new Error('Owner login failed');
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Owner login did not set a cookie');
const headers = { cookie, origin: appOrigin };
const workspaces = await request('/workspaces', { headers });
const workspace = workspaces.data.find((item) => item.slug === 'm1-workspace');
const projects = await request(`/workspaces/${workspace.id}/projects`, {
  headers,
});
const project = projects.data.find((item) => item.slug === 'm2-external');
if (!project) throw new Error('Run M2 smoke before M3 smoke');
const indexes = await request(`/projects/${project.id}/indexes`, { headers });
const index = indexes.data.find((item) => item.slug === 'demo-products');
if (!index) throw new Error('M2 demo index is required');

async function upload(name, lines) {
  const form = new FormData();
  form.set('name', name);
  form.set('format', 'JSONL');
  form.set(
    'file',
    new Blob([lines], { type: 'application/x-ndjson' }),
    `${name}.jsonl`,
  );
  return request(
    `/projects/${project.id}/uploads`,
    { method: 'POST', headers, body: form },
    201,
  );
}
async function rebuild(sourceId) {
  return request(
    `/indexes/${index.id}/rebuild`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId, idField: 'id' }),
    },
    201,
  );
}
async function waitForRun(runId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = await request(`/runs/${runId}`, { headers });
    if (
      ['SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(
        run.status,
      )
    )
      return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for ingestion run');
}

const fixture = Array.from({ length: 10_000 }, (_, id) =>
  JSON.stringify({
    id: `product-${id}`,
    title: `Product ${id}`,
    category: `Category ${id % 20}`,
    price: id + 0.5,
    in_stock: id % 3 !== 0,
  }),
).join('\n');
const source = await upload('m3-10k-fixture', fixture);
if (source.rowCount !== 10_000 || source.preview.length !== 20)
  throw new Error('Upload preview/count is incorrect');
const successful = await waitForRun((await rebuild(source.id)).id);
if (
  successful.status !== 'SUCCEEDED' ||
  successful.scanned !== 10_000 ||
  successful.succeeded !== 10_000 ||
  successful.failed !== 0
)
  throw new Error(
    `10k import did not complete cleanly: ${JSON.stringify(successful)}`,
  );
const search = await request(
  `/indexes/${index.id}/playground/search`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      q: '9999',
      queryBy: ['title'],
      page: 1,
      perPage: 10,
    }),
  },
  201,
);
if (search.found < 1)
  throw new Error('Rebuilt alias did not return the imported fixture');

const beforeFailure = await request(`/indexes/${index.id}`, { headers });
const invalid = `${JSON.stringify({ id: 'valid', title: 'Valid', category: 'Test', price: 1, in_stock: true })}\n${JSON.stringify({ id: 'invalid', title: 'Invalid', category: 'Test', price: 'not-a-number', in_stock: true })}`;
const invalidSource = await upload('m3-partial-fixture', invalid);
const partial = await waitForRun((await rebuild(invalidSource.id)).id);
if (partial.status !== 'PARTIAL_FAILED' || partial.failed !== 1)
  throw new Error('Partial import was not surfaced');
const errors = await request(`/runs/${partial.id}/errors`, { headers });
if (errors.data.length !== 1 || 'payload' in errors.data[0])
  throw new Error('Sanitized ingestion error was not recorded correctly');
const afterFailure = await request(`/indexes/${index.id}`, { headers });
if (afterFailure.activeGeneration !== beforeFailure.activeGeneration)
  throw new Error('Partial import changed the active alias generation');
const retried = await request(
  `/runs/${partial.id}/retry-failed`,
  { method: 'POST', headers },
  201,
);
const retriedResult = await waitForRun(retried.id);
if (retriedResult.status !== 'PARTIAL_FAILED' || retriedResult.failed !== 1)
  throw new Error('Retry did not preserve visible per-record failure state');

const cancellationFixture = Array.from({ length: 20_000 }, (_, id) =>
  JSON.stringify({
    id: `cancel-${id}`,
    title: `Cancel ${id}`,
    category: 'Cancellation',
    price: id + 0.25,
    in_stock: true,
  }),
).join('\n');
const cancellationSource = await upload(
  'm3-cancellation-fixture',
  cancellationFixture,
);
const cancellationRun = await rebuild(cancellationSource.id);
await request(
  `/runs/${cancellationRun.id}/cancel`,
  { method: 'POST', headers },
  201,
);
const cancelled = await waitForRun(cancellationRun.id);
if (cancelled.status !== 'CANCELLED')
  throw new Error(
    `Cancellation did not stop at a checkpoint: ${cancelled.status}`,
  );
const afterCancellation = await request(`/indexes/${index.id}`, { headers });
if (afterCancellation.activeGeneration !== beforeFailure.activeGeneration)
  throw new Error('Cancelled import changed the active alias generation');

const viewerLogin = await fetch(`${apiUrl}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'm1-viewer@example.test',
    password: 'm1-viewer-password-123',
  }),
});
const viewerCookie = viewerLogin.headers.get('set-cookie')?.split(';')[0];
if (!viewerCookie) throw new Error('Viewer login failed');
const viewerHeaders = { cookie: viewerCookie, origin: appOrigin };
await request(`/indexes/${index.id}/runs`, { headers: viewerHeaders });
const forbiddenUpload = new FormData();
forbiddenUpload.set('name', 'Forbidden');
forbiddenUpload.set('format', 'JSONL');
forbiddenUpload.set(
  'file',
  new Blob(['{"id":"forbidden"}\n']),
  'forbidden.jsonl',
);
await request(
  `/projects/${project.id}/uploads`,
  { method: 'POST', headers: viewerHeaders, body: forbiddenUpload },
  403,
);

console.log(
  'M3 smoke passed: encrypted upload preview, durable 10k import, alias switch, visible partial failure/retry, checkpoint-safe cancellation, and viewer authorization.',
);
