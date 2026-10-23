#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: OSC_COMPOSE_PROJECT=<project> ./infra/backup.sh <backup-directory>" >&2
  exit 2
fi

project_name="${OSC_COMPOSE_PROJECT:-open-search-console}"
backup_dir="$(mkdir -p "$1" && cd "$1" && pwd)"
compose="docker compose -p ${project_name}"
app_image="${OSC_BACKUP_IMAGE:-open-search-console-app:local}"
umask 077
chmod 700 "$backup_dir"

restart_stack() {
  $compose up --detach --wait >/dev/null 2>&1 || true
}
trap restart_stack EXIT INT TERM

key_fingerprint="$($compose exec -T api node -e 'const c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(process.env.APP_ENCRYPTION_KEY).digest("hex"))')"

$compose exec -T postgres sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$backup_dir/postgres.dump"
$compose exec -T redis redis-cli SAVE >/dev/null
$compose stop web worker api redis typesense >/dev/null

archive_volume() {
  volume_name="$1"
  archive_name="$2"
  docker run --rm --entrypoint sh \
    -v "${project_name}_${volume_name}:/source:ro" \
    -v "$backup_dir:/backup" \
    "$app_image" \
    -c "cd /source && tar -czf /backup/${archive_name} ."
}

archive_volume typesense-data typesense-data.tgz
archive_volume redis-data redis-data.tgz
archive_volume upload-staging upload-staging.tgz

cat >"$backup_dir/manifest.txt" <<EOF
format=osc-compose-backup-v1
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
source_project=${project_name}
source_revision=$(git rev-parse HEAD 2>/dev/null || echo unknown)
app_image=${app_image}
encryption_key_sha256=${key_fingerprint}
EOF

(
  cd "$backup_dir"
  openssl dgst -sha256 postgres.dump typesense-data.tgz redis-data.tgz upload-staging.tgz >SHA256SUMS
)

trap - EXIT INT TERM
restart_stack
echo "Backup completed at ${backup_dir}. The encryption key is not included; retain it separately."
