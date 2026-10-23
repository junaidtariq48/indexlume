#!/usr/bin/env bash
set -euo pipefail

HOST_API_PORT="${HOST_API_PORT:-3001}"
HOST_WEB_PORT="${HOST_WEB_PORT:-3000}"
export HOST_API_PORT HOST_WEB_PORT

node --input-type=module <<'NODE'
const apiPort = process.env.HOST_API_PORT;
const webPort = process.env.HOST_WEB_PORT;
const checks = [
  ['API liveness', `http://127.0.0.1:${apiPort}/api/v1/health/live`, (body) => body.status === 'ok'],
  ['API readiness', `http://127.0.0.1:${apiPort}/api/v1/health/ready`, (body) => body.status === 'ready'],
  ['Web', `http://127.0.0.1:${webPort}`, () => true],
];

async function waitFor([name, url, validate]) {
  const deadline = Date.now() + 120_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        const body = response.headers.get('content-type')?.includes('application/json')
          ? await response.json()
          : await response.text();
        if (validate(body)) {
          console.log(`${name}: ok`);
          return;
        }
      }
      lastError = new Error(`${name} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw lastError ?? new Error(`${name} did not become ready`);
}

for (const check of checks) {
  await waitFor(check);
}
NODE
