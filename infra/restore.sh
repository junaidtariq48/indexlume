#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: OSC_COMPOSE_PROJECT=<project> OSC_RESTORE_CONFIRM=<project> ./infra/restore.sh <backup-directory>" >&2
  exit 2
fi

project_name="${OSC_COMPOSE_PROJECT:-open-search-console}"
if [ "${OSC_RESTORE_CONFIRM:-}" != "$project_name" ]; then
  echo "Restore refused. Set OSC_RESTORE_CONFIRM=${project_name} to confirm the exact Compose project." >&2
  exit 2
fi

backup_dir="$(cd "$1" && pwd)"
compose="docker compose -p ${project_name}"
app_image="${OSC_BACKUP_IMAGE:-open-search-console-app:local}"

for required in manifest.txt SHA256SUMS postgres.dump typesense-data.tgz redis-data.tgz upload-staging.tgz; do
  if [ ! -f "$backup_dir/$required" ]; then
    echo "Restore refused: missing ${required}." >&2
    exit 1
  fi
done

(
  cd "$backup_dir"
  openssl dgst -sha256 postgres.dump typesense-data.tgz redis-data.tgz upload-staging.tgz >SHA256SUMS.current
  if ! cmp -s SHA256SUMS SHA256SUMS.current; then
    rm -f SHA256SUMS.current
    echo "Restore refused: backup checksum verification failed." >&2
    exit 1
  fi
  rm -f SHA256SUMS.current
)

expected_key="$(sed -n 's/^encryption_key_sha256=//p' "$backup_dir/manifest.txt")"
current_key="$($compose exec -T api node -e 'const c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(process.env.APP_ENCRYPTION_KEY).digest("hex"))')"
if [ -z "$expected_key" ] || [ "$current_key" != "$expected_key" ]; then
  echo "Restore refused: APP_ENCRYPTION_KEY does not match the backup fingerprint." >&2
  exit 1
fi

restart_stack() {
  $compose up --detach --wait >/dev/null 2>&1 || true
}
trap restart_stack EXIT INT TERM

$compose stop web worker api redis typesense >/dev/null

$compose exec -T postgres sh -c 'exec pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$backup_dir/postgres.dump"

restore_volume() {
  volume_name="$1"
  archive_name="$2"
  docker run --rm --entrypoint sh \
    -v "${project_name}_${volume_name}:/target" \
    -v "$backup_dir:/backup:ro" \
    "$app_image" \
    -c "find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /backup/${archive_name} -C /target"
}

restore_volume typesense-data typesense-data.tgz
restore_volume redis-data redis-data.tgz
restore_volume upload-staging upload-staging.tgz

trap - EXIT INT TERM
$compose up --detach --wait
echo "Restore completed for isolated Compose project ${project_name}. Run application smoke tests before returning traffic."
