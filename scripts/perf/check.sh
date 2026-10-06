#!/bin/sh
# The same required checks before each performance commit. Run from the repo.
set -eu
export TMPDIR=/tmp/arbor-r5-perf GOTMPDIR=/tmp/arbor-r5-perf/go
export GOCACHE=/tmp/arbor-r5-perf/go-cache
mkdir -p "$GOTMPDIR"
npm run test:desktop
ls scripts/e2e/*.e2e.cjs | grep -v scale-large | xargs node scripts/e2e/run.cjs --jobs 2
node scripts/e2e/run.cjs --jobs 1 scale-large
node scripts/e2e/run.cjs --jobs 1 scripts/perf/row-reuse.e2e.cjs
for name in flow workspaces multihost close; do
  xvfb-run -a node_modules/.bin/electron "scripts/test-desktop-$name.cjs" --no-sandbox
done
