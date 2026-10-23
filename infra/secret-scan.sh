#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
report_dir=${SECURITY_REPORT_DIR:-"$repo_root/artifacts/security"}
report_path="$report_dir/gitleaks.json"
gitleaks_image='zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'

mkdir -p "$report_dir"

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git "$repo_root" \
    --config "$repo_root/.gitleaks.toml" \
    --no-banner \
    --redact \
    --report-format json \
    --report-path "$report_path"
else
  docker run --rm \
    --volume "$repo_root:/repo:ro" \
    --volume "$report_dir:/reports" \
    "$gitleaks_image" \
    git /repo \
    --config /repo/.gitleaks.toml \
    --no-banner \
    --redact \
    --report-format json \
    --report-path /reports/gitleaks.json
fi

printf 'Secret scan passed; report: %s\n' "$report_path"
