import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const apiUrl = process.env.M7_TEST_API_URL ?? 'http://localhost:3301/api/v1';
const appOrigin = process.env.M7_TEST_APP_ORIGIN ?? 'http://localhost:3300';
const sourceContainer =
  process.env.M7_SOURCE_DB_CONTAINER ?? 'open-search-console-source-postgres-1';
const controlContainer =
  process.env.M7_CONTROL_DB_CONTAINER ?? 'open-search-console-postgres-1';
const workerContainer =
  process.env.M7_WORKER_CONTAINER ?? 'open-search-console-worker-1';
const fixturePath = new URL('./m7-relational-fixture.sql', import.meta.url);
const fixtureSchema = 'm7_projection_test';

let headers;
let source;
let index;
let project;
let testProjectCreated = false;
let fixtureLoaded = false;
let checkpointLock;

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function sourceSql(sql) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      sourceContainer,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'connector_admin',
      '-d',
      'connector_fixture',
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function controlSql(sql) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      controlContainer,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'open_search_console',
      '-d',
      'open_search_console',
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function docker(action, container) {
  return execFileSync('docker', [action, container], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function holdDocumentCheckpoint(documentId) {
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGAPPNAME=m7-projection-checkpoint-lock',
      controlContainer,
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-U',
      'open_search_console',
      '-d',
      'open_search_console',
      '-c',
      `BEGIN; SELECT 'M7_LOCKED' FROM projection_document_states WHERE document_id = '${documentId}' FOR UPDATE; SELECT pg_sleep(60); COMMIT;`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  checkpointLock = child;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const sleeping = controlSql(`
      SELECT count(*)
      FROM pg_stat_activity
      WHERE application_name = 'm7-projection-checkpoint-lock'
        AND wait_event = 'PgSleep';
    `).trim();
    if (sleeping === '1') return;
    if (child.exitCode !== null) {
      throw new Error(
        `Checkpoint lock exited before acquisition (${child.exitCode})`,
      );
    }
    await pause(100);
  }
  throw new Error('Timed out acquiring the checkpoint row lock');
}

function releaseCandidateCheckpoint() {
  try {
    controlSql(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE application_name = 'm7-projection-checkpoint-lock'
        AND pid <> pg_backend_pid();
    `);
  } finally {
    checkpointLock?.kill('SIGTERM');
    checkpointLock = undefined;
  }
}

async function request(path, init = {}, expected = 200) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: expected ${expected}, got ${response.status}: ${text}`,
    );
  }
  return text ? JSON.parse(text) : undefined;
}

async function login() {
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'm1-owner@example.test',
      password: 'm1-owner-password-123',
    }),
  });
  if (response.status !== 201) throw new Error('Owner login failed');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Login did not set a session cookie');
  return { cookie, origin: appOrigin };
}

async function waitForGeneration(projectionId) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await request(
      `/projects/${project.id}/projections/${projectionId}/generations`,
      { headers },
    );
    const generation = response.data[0];
    if (generation?.status === 'ACTIVE') return generation;
    if (generation?.status === 'FAILED') {
      throw new Error(
        `Projection generation failed: ${generation.errorCode ?? 'unknown'}`,
      );
    }
    await pause(250);
  }
  throw new Error('Timed out waiting for the projection generation');
}

async function waitForReconciliation(projectionId, runId, statuses) {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    const run = await request(
      `/projects/${project.id}/projections/${projectionId}/reconcile/${runId}`,
      { headers },
    );
    if (statuses.includes(run.status)) return run;
    await pause(250);
  }
  throw new Error(
    `Timed out waiting for reconciliation ${runId} (${statuses.join(', ')})`,
  );
}

async function startReconciliation(projectionId, label) {
  const run = await request(
    `/projects/${project.id}/projections/${projectionId}/reconcile/preview`,
    {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `m7-${label}-${Date.now()}` },
    },
    201,
  );
  return waitForReconciliation(projectionId, run.id, [
    'COMPLETE',
    'AWAITING_CONFIRMATION',
    'INVALID',
  ]);
}

async function search(title) {
  return request(
    `/indexes/${index.id}/playground/search`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        q: title,
        queryBy: ['title'],
        page: 1,
        perPage: 10,
      }),
    },
    201,
  );
}

function onlyDocument(result, label) {
  const exact = result.hits?.filter((hit) => hit.document?.title === label);
  if (exact?.length !== 1) {
    throw new Error(
      `${label}: expected one exact document, got ${JSON.stringify(result.hits?.map((hit) => hit.document?.title))}`,
    );
  }
  return exact[0].document;
}

async function cleanup() {
  if (checkpointLock) releaseCandidateCheckpoint();
  try {
    docker('start', workerContainer);
  } catch {
    // Cleanup is best effort; preserve the integration assertion failure.
  }
  if (headers && index) {
    await request(
      `/indexes/${index.id}?confirm=${encodeURIComponent(index.slug)}`,
      { method: 'DELETE', headers },
    ).catch(() => undefined);
  }
  if (headers && source) {
    await request(`/sources/${source.id}`, {
      method: 'DELETE',
      headers,
    }).catch(() => undefined);
  }
  if (headers && project && testProjectCreated) {
    await request(`/projects/${project.id}`, {
      method: 'DELETE',
      headers,
    }).catch(() => undefined);
  }
  if (fixtureLoaded) {
    try {
      sourceSql(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE;`);
    } catch {
      // Preserve the original test failure; the fixture is isolated and can be
      // safely replaced by the next invocation.
    }
  }
}

try {
  sourceSql(readFileSync(fixturePath, 'utf8'));
  fixtureLoaded = true;
  headers = await login();

  const workspaces = await request('/workspaces', { headers });
  const workspace = workspaces.data.find(
    (candidate) => candidate.slug === 'm1-workspace',
  );
  if (!workspace) throw new Error('M1 workspace is required');

  const connections = await request(
    `/workspaces/${workspace.id}/typesense-connections`,
    { headers },
  );
  const typesenseConnection =
    connections.data.find(
      (candidate) => candidate.name === 'M2 External Typesense',
    ) ?? connections.data[0];
  if (!typesenseConnection) {
    throw new Error('A validated Typesense connection is required');
  }

  const suffix = Date.now().toString(36);
  project = await request(
    `/workspaces/${workspace.id}/projects`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `M7 relational integration ${suffix}`,
        slug: `m7-relational-${suffix}`,
        typesenseConnectionId: typesenseConnection.id,
      }),
    },
    201,
  );
  testProjectCreated = true;

  const testedConnection = await request(
    `/typesense-connections/${typesenseConnection.id}/test`,
    {
      method: 'POST',
      headers,
    },
    201,
  );
  if (!testedConnection.ok) {
    throw new Error('Typesense connection validation failed');
  }

  const createdProject = await request(`/projects/${project.id}`, {
    headers,
  });
  if (createdProject.typesenseConnectionId !== typesenseConnection.id) {
    throw new Error('Integration project is not linked to Typesense');
  }

  index = await request(
    `/projects/${project.id}/indexes`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `M7 relational integration ${suffix}`,
        slug: `m7-relational-${suffix}`,
        withDemoData: false,
        fields: [
          {
            name: 'title',
            type: 'string',
            searchable: true,
            facet: false,
            sort: false,
            optional: false,
          },
          {
            name: 'stock',
            type: 'int64',
            searchable: false,
            facet: false,
            sort: true,
            optional: false,
          },
          {
            name: 'tags',
            type: 'string[]',
            searchable: false,
            facet: true,
            sort: false,
            optional: false,
          },
        ],
      }),
    },
    201,
  );

  source = await request(
    `/projects/${project.id}/sources`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `M7 relational source ${suffix}`,
        connectionUrl:
          'postgresql://connector_reader:connector-read-only@source-postgres:5432/connector_fixture',
        tlsPolicy: 'ALLOW_INSECURE',
      }),
    },
    201,
  );

  const connection = await request(
    `/sources/${source.id}/test`,
    { method: 'POST', headers },
    201,
  );
  if (!connection.ok) throw new Error('Fixture PostgreSQL connection failed');

  const config = {
    version: 1,
    root: {
      schema: fixtureSchema,
      table: 'products',
      pk: ['id'],
      idPrefix: 'm7-',
      eligibility: { deletedAtIsNull: 'deleted_at' },
      changeTracking: {
        mode: 'poll',
        updatedAt: 'updated_at',
        key: ['id'],
        overlapSeconds: 2,
      },
    },
    relations: [
      {
        id: 'inventory',
        kind: 'one_to_many',
        from: { relation: 'root', columns: ['id'] },
        to: {
          schema: fixtureSchema,
          table: 'inventory',
          columns: ['product_id'],
        },
        required: false,
        limitPerRoot: 20,
        predicates: [],
        changeTracking: { mode: 'reconcile_only' },
      },
      {
        id: 'productTags',
        kind: 'one_to_many',
        from: { relation: 'root', columns: ['id'] },
        to: {
          schema: fixtureSchema,
          table: 'product_tags',
          columns: ['product_id'],
        },
        required: false,
        limitPerRoot: 20,
        predicates: [],
        changeTracking: { mode: 'reconcile_only' },
      },
      {
        id: 'tags',
        kind: 'many_to_one',
        from: { relation: 'productTags', columns: ['tag_id'] },
        to: { schema: fixtureSchema, table: 'tags', columns: ['id'] },
        required: false,
        limitPerRoot: 20,
        predicates: [],
        changeTracking: { mode: 'reconcile_only' },
      },
    ],
    fields: [
      { path: 'root.title', targetField: 'title', op: 'identity' },
      {
        path: 'inventory.quantity',
        targetField: 'stock',
        op: 'sum',
        nullDefault: 0,
      },
      {
        path: 'tags.name',
        targetField: 'tags',
        op: 'unique_sorted_array',
        nullDefault: [],
        maxItems: 20,
      },
    ],
    limits: {
      maxTables: 8,
      maxFields: 80,
      maxRelationDepth: 3,
      maxRowsPerRoot: 100,
      maxDocumentBytes: 262144,
      batchRoots: 2,
      queryTimeoutMs: 100,
    },
    sync: {
      strategy: 'poll_and_reconcile',
      pollSeconds: 300,
      reconcileHours: 24,
    },
  };

  const projection = await request(
    `/projects/${project.id}/projections`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourceId: source.id,
        searchIndexId: index.id,
        name: `M7 relational projection ${suffix}`,
        config,
      }),
    },
    201,
  );
  const versionId = projection.draftVersion?.id;
  if (!versionId) throw new Error('Projection draft version was not created');

  const validation = await request(
    `/projects/${project.id}/projections/${projection.id}/validate`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionId }),
    },
    201,
  );
  if (!validation.valid) {
    throw new Error(
      `Projection validation failed: ${JSON.stringify(validation)}`,
    );
  }

  await request(
    `/projects/${project.id}/projections/${projection.id}/publish`,
    {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `m7-publish-${suffix}` },
      body: JSON.stringify({
        versionId,
        eventualConsistencyAccepted: true,
      }),
    },
    201,
  );
  await waitForGeneration(projection.id);

  const initialKeyboard = onlyDocument(
    await search('M7 Keyboard'),
    'M7 Keyboard',
  );
  if (
    initialKeyboard.stock !== 3 ||
    JSON.stringify(initialKeyboard.tags) !==
      JSON.stringify(['Blue', 'Featured'])
  ) {
    throw new Error(
      `Initial multi-table document is incorrect: ${JSON.stringify(initialKeyboard)}`,
    );
  }

  sourceSql(`DELETE FROM ${fixtureSchema}.inventory WHERE id = 'inv-001';`);
  const childRun = await startReconciliation(projection.id, 'child-delete');
  if (childRun.status !== 'COMPLETE' || childRun.expectedCount !== 0) {
    throw new Error(
      `Hard child deletion did not reconcile safely: ${JSON.stringify(childRun)}`,
    );
  }
  const afterChildDelete = onlyDocument(
    await search('M7 Keyboard'),
    'M7 Keyboard',
  );
  if (afterChildDelete.stock !== 0) {
    throw new Error('Hard child deletion did not rebuild the root document');
  }

  sourceSql(`DELETE FROM ${fixtureSchema}.product_tags WHERE id = 'pt-001';`);
  const junctionRun = await startReconciliation(
    projection.id,
    'junction-delete',
  );
  if (junctionRun.status !== 'COMPLETE' || junctionRun.expectedCount !== 0) {
    throw new Error(
      `Hard junction deletion did not reconcile safely: ${JSON.stringify(junctionRun)}`,
    );
  }
  const afterJunctionDelete = onlyDocument(
    await search('M7 Keyboard'),
    'M7 Keyboard',
  );
  if (
    JSON.stringify(afterJunctionDelete.tags) !== JSON.stringify(['Featured'])
  ) {
    throw new Error('Hard junction deletion left stale nested fields');
  }

  sourceSql(`DELETE FROM ${fixtureSchema}.products WHERE id = 'p-002';`);
  const rootRun = await startReconciliation(projection.id, 'root-delete');
  if (
    rootRun.status !== 'AWAITING_CONFIRMATION' ||
    rootRun.expectedCount !== 1 ||
    !rootRun.confirmationToken
  ) {
    throw new Error(
      `Hard root deletion did not produce one guarded candidate: ${JSON.stringify(rootRun)}`,
    );
  }
  await request(
    `/projects/${project.id}/projections/${projection.id}/reconcile/${rootRun.id}/confirm`,
    {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `m7-confirm-${suffix}` },
      body: JSON.stringify({
        token: rootRun.confirmationToken,
        expectedCount: 1,
      }),
    },
    201,
  );
  const executedRootRun = await waitForReconciliation(
    projection.id,
    rootRun.id,
    ['EXECUTED', 'INVALID'],
  );
  if (executedRootRun.status !== 'EXECUTED') {
    throw new Error(
      `Hard root deletion was not executed: ${JSON.stringify(executedRootRun)}`,
    );
  }
  const removedRoot = await search('M7 Mouse');
  if (removedRoot.hits?.some((hit) => hit.document?.title === 'M7 Mouse')) {
    throw new Error('Confirmed hard root deletion remains searchable');
  }

  sourceSql(
    `UPDATE ${fixtureSchema}.controls SET slow_final_page = true WHERE singleton;`,
  );
  const timeoutRun = await startReconciliation(projection.id, 'timeout');
  if (
    timeoutRun.status !== 'INVALID' ||
    timeoutRun.complete ||
    timeoutRun.expectedCount !== 0
  ) {
    throw new Error(
      `Final-page timeout did not fail closed: ${JSON.stringify(timeoutRun)}`,
    );
  }
  const preservedFinalPage = await search('M7 Speaker');
  if (
    !preservedFinalPage.hits?.some(
      (hit) => hit.document?.title === 'M7 Speaker',
    )
  ) {
    throw new Error('Incomplete reconciliation deleted a final-page document');
  }

  sourceSql(
    `UPDATE ${fixtureSchema}.controls SET slow_final_page = false WHERE singleton;`,
  );
  sourceSql(`DELETE FROM ${fixtureSchema}.products WHERE id = 'p-003';`);
  const crashRun = await startReconciliation(projection.id, 'worker-crash');
  if (
    crashRun.status !== 'AWAITING_CONFIRMATION' ||
    crashRun.expectedCount !== 1 ||
    crashRun.candidates?.length !== 1 ||
    !crashRun.confirmationToken
  ) {
    throw new Error(
      `Worker-crash fixture did not produce one guarded candidate: ${JSON.stringify(crashRun)}`,
    );
  }
  await holdDocumentCheckpoint(crashRun.candidates[0].documentId);
  await request(
    `/projects/${project.id}/projections/${projection.id}/reconcile/${crashRun.id}/confirm`,
    {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `m7-crash-${suffix}` },
      body: JSON.stringify({
        token: crashRun.confirmationToken,
        expectedCount: 1,
      }),
    },
    201,
  );

  let deletedBeforeCheckpoint = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await search('M7 Monitor');
    if (!result.hits?.some((hit) => hit.document?.title === 'M7 Monitor')) {
      const state = await request(
        `/projects/${project.id}/projections/${projection.id}/reconcile/${crashRun.id}`,
        { headers },
      );
      if (state.status !== 'EXECUTING') {
        throw new Error(
          `Checkpoint lock did not preserve EXECUTING state: ${JSON.stringify(state)}`,
        );
      }
      deletedBeforeCheckpoint = true;
      break;
    }
    await pause(100);
  }
  if (!deletedBeforeCheckpoint) {
    throw new Error(
      'Typesense deletion did not reach the checkpoint crash window',
    );
  }

  docker('kill', workerContainer);
  releaseCandidateCheckpoint();
  await pause(500);
  docker('start', workerContainer);

  const replayedCrashRun = await waitForReconciliation(
    projection.id,
    crashRun.id,
    ['EXECUTED', 'INVALID'],
  );
  if (replayedCrashRun.status !== 'EXECUTED') {
    throw new Error(
      `Worker crash did not replay to a durable checkpoint: ${JSON.stringify(replayedCrashRun)}`,
    );
  }
  const replayedDeletion = await search('M7 Monitor');
  if (
    replayedDeletion.hits?.some((hit) => hit.document?.title === 'M7 Monitor')
  ) {
    throw new Error(
      'Replayed deletion restored or retained the stale document',
    );
  }

  console.log(
    JSON.stringify(
      {
        event: 'm7_relational_integration_passed',
        fixture: {
          roots: 4,
          inventoryRows: 4,
          junctionRows: 5,
          tags: 3,
          batchRoots: 2,
          queryTimeoutMs: 100,
        },
        verified: [
          'hard_child_delete_rebuild',
          'hard_junction_delete_rebuild',
          'hard_root_delete_guarded_execution',
          'final_page_timeout_fail_closed',
          'worker_death_after_typesense_before_checkpoint',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await cleanup();
}
