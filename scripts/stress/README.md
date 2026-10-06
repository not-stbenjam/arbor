# CLI reliability tests

These tests use real Git repositories made by `scripts/e2e/fixture.cjs`. Every
scenario starts in a new empty folder and removes it in `finally`. The CLI,
Git configuration, statistics, simulated SSH hosts, and helper markers use
that fixture's environment. No real SSH host is contacted. Product code and
the existing fixture builder are unchanged.

From this checkout:

```sh
export TMPDIR=/tmp/arbor-r5-cli GOTMPDIR=/tmp/arbor-r5-cli/go
export GOCACHE=/tmp/arbor-r5-cli/cache CCACHE_DIR=/tmp/arbor-r5-cli/ccache
export GOMAXPROCS=2
mkdir -p "$GOTMPDIR"
# npm ci is needed only if node_modules is absent.
node scripts/build-desktop.cjs --prepare
node scripts/stress/run.cjs
node scripts/stress/run.cjs commands consistency ssh
STRESS_SEED=20261005 node scripts/stress/run.cjs interruption
node scripts/stress/fuzz.cjs
```

The runner runs topics sequentially and emits one timed PASS/FAIL per topic.
It keeps running after a failure and exits nonzero if any topic failed.
The `commands` topic checks CLI status 2 for usage errors, 1 for refused
removals, 3 for incomplete scans with `--strict`, and 130 for interruption.
Successful previews and no-match scans return 0. The former
`bugs/exit-codes.cjs` regression is now part of `commands.cjs`, alongside the
age-filter, sort, and strict scripting examples. The runner
excludes `bugs/` unless explicitly named. Each bug script asserts the desired
behavior, so confirmed defects fail. All bug scripts create their own empty
fixture; no manual repository setup or destructive command is needed.

```sh
node scripts/stress/run.cjs bugs/symlink-removal
node scripts/stress/run.cjs bugs/exclude-panic
```

`STRESS_INTERRUPTS` defaults to 240, distributed over scan/removal and SIGINT,
SIGTERM, SIGHUP, SIGKILL. A seed controls delay, not operating-system scheduling.
The passing topic interrupts scans and pauses before the second Git removal,
then interrupts at that boundary. The unrestricted mid-removal check lives in
`bugs/interrupted-removal.cjs`; seed 20261007 exposed a stale registration.
`bugs/interrupted-delete.cjs` reproduces that failure reliably on Linux using
a fixture-local C shim that pauses actual Git just after its successful rmdir
(requires the C compiler already used by Go race tests).
Each trial checks fsck, registration paths, Git lock files, statistics JSON,
and completion on retry. A child process group bounds each asynchronous run
and is killed on timeout or completion to prevent orphan Git/SSH children.
Statistics loss after SIGKILL is checked separately in `bugs/`.

`STRESS_SCALE` defaults to `1000,5000`. Scale uses 100 worktrees per repository,
no checkout files, a real index, and ten hard-linked discovery files per
worktree. The index deliberately makes absent tracked files dirty, so removal
uses explicit `--all --force --yes`. An excluded sparse 4 GiB file checks that
cleanup retains excluded data. Fixtures are disposed between sizes. The
printed file count is discovery files plus worktree `.git` pointers; shared
repository metadata is additional. Peak RSS is GNU `/usr/bin/time -v` when
installed, otherwise Python `wait4().ru_maxrss` on Linux. Both are the maximum
child-process RSS, not the sum of simultaneously running Git processes.

The fuzz runner uses one worker, `go test -p 2`, and 120 seconds per target.
Pass target names to run a subset. The known exclusion trailing-escape panic
is preserved in `testdata/stress/exclusion-panic.txt`, a skipped regular Go
regression, and an active failing CLI reproducer. Fuzzing skips that known
input family to continue exploring other inputs; it does not catch or hide
other panics. Desktop requests are argv, not JSON, in this version. The Go
request target exercises their actual normalization boundary. Configuration
JSON is embedded defaults rather than a user-supplied Go configuration file.

The read-only topic tests hooks, fsmonitor, pager, editor, aliases, diff,
textconv, and unchanged-file filters, with a content/mode snapshot of all
repositories. Both divergent histories and a matching index are exercised. The same-size changed-file clean-filter case is a known failure
in `bugs/read-only-filter.cjs`; that script reports helper invocations for
list, cleanup preview, and stats separately.

Limits are printed explicitly: no real `/` scan, no macOS GUI launch test
because of its fixed `/Applications` lookup, and no unseeded CLI SSH download
because its production HTTPS release URL cannot be replaced through CLI
configuration. Existing Go provisioning tests use injected HTTP transports.
Invalid UTF-8 paths have a failing JSON round-trip test in `bugs/`. Git itself
forbids some branch characters and its `.lock` suffix limits loose branch
components to 250 bytes; directory-name cases still use 255 bytes.

`helpers.cjs` adds process ownership, async CLI execution, deterministic random
numbers, and repository integrity checks. Those general helpers could move
into the existing fixture builder. `measure.cjs` is stress-specific.

After all processes finish, remove only the dedicated scratch directory:

```sh
rm -rf /tmp/arbor-r5-cli
```
