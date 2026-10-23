#!/bin/sh
set -eu

version=${1:-}
if [ -z "$version" ]; then
  echo "Usage: $0 <version> [output-directory]" >&2
  exit 2
fi

case "$version" in
  *[!0-9A-Za-z.-]* | .* | *..* | *.)
    echo "Release version contains unsupported characters: $version" >&2
    exit 2
    ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir=${2:-"$repo_root/artifacts/release"}
revision=${RELEASE_REVISION:-HEAD}
commit=$(git -C "$repo_root" rev-parse --verify "$revision^{commit}")
archive_name="indexlume-$version.tar.gz"
archive_path="$output_dir/$archive_name"
manifest_path="$output_dir/release-manifest.json"
checksums_path="$output_dir/SHA256SUMS"
temporary_dir=$(mktemp -d)

cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$output_dir"
rm -f "$archive_path" "$manifest_path" "$checksums_path"

git -C "$repo_root" archive \
  --format=tar \
  --prefix="indexlume-$version/" \
  "$commit" >"$temporary_dir/source.tar"
gzip -n -9 <"$temporary_dir/source.tar" >"$archive_path"

for required in LICENSE NOTICE COPYRIGHT THIRD_PARTY_NOTICES.md README.md; do
  if ! tar -tzf "$archive_path" | grep -Fxq "indexlume-$version/$required"; then
    echo "Release archive is missing required file: $required" >&2
    exit 1
  fi
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

archive_sha256=$(sha256_file "$archive_path")
cat >"$manifest_path" <<EOF
{
  "project": "Indexlume",
  "version": "$version",
  "revision": "$commit",
  "sourceArchive": "$archive_name",
  "sourceArchiveSha256": "$archive_sha256",
  "distributionBoundary": "Source archive only; no Oryxsol-hosted Typesense or Redis image is included."
}
EOF

(
  cd "$output_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$archive_name" "$(basename "$manifest_path")" >"$(basename "$checksums_path")"
  else
    shasum -a 256 "$archive_name" "$(basename "$manifest_path")" >"$(basename "$checksums_path")"
  fi
)

echo "Created $archive_path"
echo "Revision: $commit"
echo "SHA-256: $archive_sha256"
