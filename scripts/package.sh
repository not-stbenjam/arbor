#!/usr/bin/env bash
# Build standalone CLI packages for every platform, including SSH provisioning.
set -euo pipefail

cd "$(dirname "$0")/.."
version="${1:-dev}"
go_bin="${GO:-go}"
case "$version" in
  ''|*[!a-zA-Z0-9._+-]*) printf 'Invalid version: %s\n' "$version" >&2; exit 1 ;;
esac

mkdir -p dist
staging="$(mktemp -d "${TMPDIR:-/tmp}/arbor-package.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
archives=()

for platform in darwin linux; do
  for architecture in amd64 arm64; do
    name="arbor_${version}_${platform}_${architecture}"
    package_dir="$staging/$name"
    mkdir -p "$package_dir"
    printf 'Building %s/%s…\n' "$platform" "$architecture"
    CGO_ENABLED=0 GOOS="$platform" GOARCH="$architecture" "$go_bin" build \
      -trimpath -ldflags "-s -w -X main.version=$version" \
      -o "$package_dir/arbor" ./cmd/arbor
    cp README.md LICENSE "$package_dir/"
    tar -czf "dist/$name.tar.gz" -C "$staging" "$name"
    archives+=("$name.tar.gz")
  done
done

# Hash only this version's outputs, even when dist contains older builds.
(
  cd dist
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${archives[@]}" > "arbor_${version}_checksums.txt"
  else
    shasum -a 256 "${archives[@]}" > "arbor_${version}_checksums.txt"
  fi
)
printf '\nPackages ready in dist/\n'
