#!/usr/bin/env bash
# Validate the distributed archive, not just the bundle before packaging.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Mac package validation must run on macOS (uses Apple's ditto and codesign)." >&2
  exit 1
fi
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: bash scripts/verify-macos-package.sh PATH_TO_APP.zip" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
expected_version="${ARBOR_VERSION:-$(node -p "require(process.argv[1]).version" "$script_dir/../package.json")}"
expected_version="v${expected_version#v}"
verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbor-package-check.XXXXXX")"
# This directory is created exclusively by this invocation; never clean the
# archive's source directory or a caller-provided extraction destination.
trap 'rm -rf -- "$verify_dir"' EXIT

echo "Checking native extraction of $1"
/usr/bin/ditto -x -k "$1" "$verify_dir"
app="$verify_dir/Arbor.app"
test -d "$app"
test -x "$app/Contents/MacOS/Arbor"
test -x "$app/Contents/Resources/bin/arbor-cli"
/usr/bin/plutil -lint "$app/Contents/Info.plist"

framework="$app/Contents/Frameworks/Electron Framework.framework"
test -L "$framework/Versions/Current"
test -L "$framework/Electron Framework"
while IFS= read -r -d '' link; do
  if [[ ! -e "$link" ]]; then
    echo "Broken framework symlink after extraction: $link" >&2
    exit 1
  fi
done < <(find "$app/Contents/Frameworks" -type l -print0)

# Ad-hoc signing is intentional until Developer ID credentials are configured.
# Verification still catches archive damage to executable bits or symlinks.
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
actual_version="$("$app/Contents/Resources/bin/arbor-cli" version)"
if [[ "$actual_version" != "arbor $expected_version" ]]; then
  echo "Embedded CLI version mismatch: expected arbor $expected_version, got $actual_version" >&2
  exit 1
fi
mkdir "$verify_dir/empty-scan-root"
"$app/Contents/Resources/bin/arbor-cli" list --path "$verify_dir/empty-scan-root" --json > "$verify_dir/scan.json"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$verify_dir/scan.json"
echo "Native extraction, bundle signature, framework links, and embedded CLI verified: $1"
