#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
report_dir=${SECURITY_REPORT_DIR:-"$repo_root/artifacts/security"}
trivy_cache=${TRIVY_CACHE_VOLUME:-osc-trivy-cache}
trivy_image='aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa'
app_image=${SECURITY_APP_IMAGE:-open-search-console-app:security}
postgres_image='open-search-console-postgres:17.11-bookworm-security'
typesense_image='open-search-console-typesense:30.2-security'

mkdir -p "$report_dir"

docker build --pull --no-cache --provenance=false \
  --file "$repo_root/infra/Dockerfile" \
  --tag "$app_image" \
  "$repo_root"

docker build --pull --no-cache --provenance=false \
  --file "$repo_root/infra/postgres.Dockerfile" \
  --tag "$postgres_image" \
  "$repo_root"

docker build --pull --no-cache --provenance=false \
  --file "$repo_root/infra/typesense.Dockerfile" \
  --tag "$typesense_image" \
  "$repo_root"

report_paths=''
for image in \
  "$app_image" \
  "$postgres_image" \
  'redis:8.10.2' \
  "$typesense_image"
do
  report_name=$(printf '%s' "$image" | tr '/:@' '---')
  vulnerability_report="$report_dir/$report_name.vulnerabilities.json"
  report_paths="$report_paths $vulnerability_report"

  case "$image" in
    redis:*) docker pull "$image" >/dev/null ;;
  esac

  docker run --rm \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$trivy_cache:/root/.cache/trivy" \
    --volume "$report_dir:/reports" \
    "$trivy_image" image \
    --scanners vuln \
    --format json \
    --output "/reports/$report_name.vulnerabilities.json" \
    --no-progress \
    --skip-version-check \
    "$image"

  docker run --rm \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume "$trivy_cache:/root/.cache/trivy" \
    --volume "$report_dir:/reports" \
    "$trivy_image" image \
    --scanners vuln \
    --format cyclonedx \
    --output "/reports/$report_name.cdx.json" \
    --no-progress \
    --skip-db-update \
    --skip-version-check \
    "$image"

done

docker run --rm \
  --volume "$trivy_cache:/root/.cache/trivy" \
  "$trivy_image" version --format json >"$report_dir/trivy-version.json"

# shellcheck disable=SC2086 # Intentionally expand the current run's paths.
node "$repo_root/infra/check-image-vulnerabilities.mjs" $report_paths

printf 'Image vulnerability gate passed and CycloneDX SBOMs were written to %s\n' "$report_dir"
