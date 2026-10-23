#!/bin/sh
set -eu

project_name="${M7_MIGRATION_PROJECT:-osc-m7-migration}"
compose="docker compose -p ${project_name}"

cleanup() {
  $compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cleanup
$compose up --detach --wait postgres
$compose run --rm --no-deps api \
  packages/db/node_modules/.bin/prisma migrate deploy \
  --config packages/db/prisma.config.ts
$compose run --rm --no-deps api \
  packages/db/node_modules/.bin/prisma migrate deploy \
  --config packages/db/prisma.config.ts

expected="$(find packages/db/prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
applied="$($compose exec -T postgres sh -c 'psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null"')"

if [ "$applied" != "$expected" ]; then
  echo "Migration test failed: expected ${expected} applied migrations, found ${applied}." >&2
  exit 1
fi

echo "Migration test passed: ${applied} migrations applied to an empty database and a second deploy was idempotent."
