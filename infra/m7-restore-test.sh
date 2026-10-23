#!/bin/sh
set -eu

project_name="${M7_RESTORE_PROJECT:-osc-m7-restore}"
api_port="${M7_API_PORT:-34001}"
web_port="${M7_WEB_PORT:-34000}"
backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/osc-m7-backup.XXXXXX")"

export HOST_API_PORT="$api_port"
export HOST_WEB_PORT="$web_port"
export APP_ORIGIN="http://localhost:${web_port}"
export NEXT_PUBLIC_API_URL="http://localhost:${api_port}"
export M1_API_URL="http://localhost:${api_port}/api/v1"
export M1_APP_ORIGIN="$APP_ORIGIN"
export M2_API_URL="$M1_API_URL"
export M2_APP_ORIGIN="$APP_ORIGIN"
export M2_TYPESENSE_API_KEY="${TYPESENSE_API_KEY:-local-typesense-admin-key-change-me}"
# The drill intentionally connects to the private, plain-HTTP Typesense service
# on the isolated Compose network. Keep these development-only exceptions
# scoped to this test process so the application defaults remain deny-by-default.
export ALLOW_PRIVATE_TYPESENSE=true
export ALLOW_INSECURE_TYPESENSE=true

compose="docker compose -p ${project_name}"

cleanup() {
  $compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$backup_dir"
}
trap cleanup EXIT INT TERM

$compose down --volumes --remove-orphans >/dev/null 2>&1 || true
$compose up --detach --wait
node infra/m1-smoke.mjs
node infra/m2-smoke.mjs

OSC_COMPOSE_PROJECT="$project_name" ./infra/backup.sh "$backup_dir"

$compose down --volumes --remove-orphans
$compose up --detach --wait

OSC_COMPOSE_PROJECT="$project_name" \
  OSC_RESTORE_CONFIRM="$project_name" \
  ./infra/restore.sh "$backup_dir"

node infra/m2-smoke.mjs
echo "M7 restore test passed: metadata, encrypted connection usability, Typesense alias, documents, Redis, and staging volumes survived an isolated destroy-and-restore drill."
