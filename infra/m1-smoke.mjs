const apiUrl = process.env.M1_API_URL ?? 'http://localhost:3301/api/v1';
const appOrigin = process.env.M1_APP_ORIGIN ?? 'http://localhost:3300';
const setupToken = process.env.SETUP_TOKEN ?? 'local-setup-token-change-me';
const ownerEmail = 'm1-owner@example.test';
const ownerPassword = 'm1-owner-password-123';
const viewerEmail = 'm1-viewer@example.test';
const viewerPassword = 'm1-viewer-password-123';

async function request(path, init = {}, expected = 200) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (response.status !== expected) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${expected}, got ${response.status}: ${await response.text()}`,
    );
  }
  const body = response.status === 204 ? undefined : await response.json();
  return { body, response };
}

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Login did not set a session cookie');
  return cookie;
}

const status = await request('/setup/status');
if (!status.body.needsSetup) {
  throw new Error('M1 smoke requires a fresh database with setup incomplete');
}

await request(
  '/setup/owner',
  {
    method: 'POST',
    headers: { 'x-setup-token': 'invalid-setup-token' },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  },
  403,
);

await request(
  '/setup/owner',
  {
    method: 'POST',
    headers: { 'x-setup-token': setupToken },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  },
  201,
);
await request(
  '/setup/owner',
  {
    method: 'POST',
    headers: { 'x-setup-token': setupToken },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  },
  409,
);

const ownerLogin = await request(
  '/auth/login',
  {
    method: 'POST',
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  },
  201,
);
const ownerCookie = cookieFrom(ownerLogin.response);
const ownerHeaders = { cookie: ownerCookie, origin: appOrigin };

await request(
  '/workspaces',
  {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: JSON.stringify({ name: 'Blocked', slug: 'blocked' }),
  },
  403,
);

const workspace = await request(
  '/workspaces',
  {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'M1 Workspace', slug: 'm1-workspace' }),
  },
  201,
);
const privateWorkspace = await request(
  '/workspaces',
  {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      name: 'Private Workspace',
      slug: 'private-workspace',
    }),
  },
  201,
);
await request(
  `/workspaces/${workspace.body.id}/projects`,
  {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ name: 'Catalog', slug: 'catalog' }),
  },
  201,
);
await request(
  `/workspaces/${workspace.body.id}/members`,
  {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      email: viewerEmail,
      password: viewerPassword,
      role: 'VIEWER',
    }),
  },
  201,
);

const viewerLogin = await request(
  '/auth/login',
  {
    method: 'POST',
    body: JSON.stringify({ email: viewerEmail, password: viewerPassword }),
  },
  201,
);
const viewerCookie = cookieFrom(viewerLogin.response);
const viewerHeaders = { cookie: viewerCookie, origin: appOrigin };
await request(`/workspaces/${workspace.body.id}/projects`, {
  headers: viewerHeaders,
});
await request(
  `/workspaces/${workspace.body.id}/projects`,
  {
    method: 'POST',
    headers: viewerHeaders,
    body: JSON.stringify({ name: 'Forbidden', slug: 'forbidden' }),
  },
  403,
);
await request(
  `/workspaces/${privateWorkspace.body.id}`,
  { headers: viewerHeaders },
  404,
);
await request('/auth/logout', { method: 'POST', headers: viewerHeaders }, 201);
await request('/auth/me', { headers: { cookie: viewerCookie } }, 401);

console.log(
  'M1 smoke passed: setup lock, sessions, CRUD, scoped access, and viewer permissions.',
);
