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
It keeps running after a failure and exits nonzero if any topic failed. A
check that fails because the program is wrong goes in `bugs/` until it is
fixed, where the runner leaves it out unless it is named; each such script
asserts the behaviour wanted, so a confirmed defect fails. Once fixed it
moves into a topic. `safety.cjs` holds the ones that were: a symbolic link
followed to another worktree, a malformed exclusion that crashed, an empty
`--head`, an emptied folder not put back, a path that is not valid text, and
refs of a worktree's own. The `commands` topic checks status 2 for usage
errors, 1 for refused removals, 3 for incomplete scans with `--strict`, and
130 for interruption, alongside the age-filter, sort and strict examples.

```sh
node scripts/stress/run.cjs safety
```

`STRESS_INTERRUPTS` defaults to 240, distributed over scan/removal and SIGINT,
SIGTERM, SIGHUP, SIGKILL. A seed controls delay, not operating-system scheduling.
`interruption.cjs` interrupts scans and pauses before the second Git removal,
then interrupts at that boundary. `interrupted-removal.cjs` interrupts at any
moment of a removal, and `interrupted-delete.cjs` at the worst one: it uses a
fixture-local C shim to pause actual Git just after it has removed the folder
and before it has removed its record (it needs the C compiler Go's race tests
already use). Both pass because the command that deletes is not stopped when
Arbor is: Arbor finishes the worktree it is on and begins no other.
Each trial checks fsck, registration paths, Git lock files, statistics JSON,
and completion on retry. A child process group bounds each asynchronous run
and is killed on timeout or completion to prevent orphan Git/SSH children.
Statistics for removals completed before a SIGKILL are not written, since a
batch records them when it ends; that is accepted, and not tested for.

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
Pass target names to run a subset. The exclusion pattern ending in a lone
backslash that fuzzing found is kept in `testdata/stress/exclusion-panic.txt`
and as a regular Go test. Desktop requests are argv, not JSON, in this version.
The Go request target exercises their actual normalization boundary.
Configuration JSON is embedded defaults rather than a user-supplied Go
configuration file.

The read-only topics test hooks, fsmonitor, pager, editor, aliases, diff,
textconv and filters, with a content/mode snapshot of all repositories. Both
divergent histories and a matching index are exercised. `readonly-filter.cjs`
changes a file without changing its size, which is when Git would run a clean
filter to compare it, and checks that list, cleanup preview and stats start
none of the repository's own.

Limits are printed explicitly: no real `/` scan, no macOS GUI launch test
because of its fixed `/Applications` lookup, and no unseeded CLI SSH download
because its production HTTPS release URL cannot be replaced through CLI
configuration. Existing Go provisioning tests use injected HTTP transports.
Git itself forbids some branch characters and its `.lock` suffix limits loose
branch components to 250 bytes; directory-name cases still use 255 bytes.

Known and accepted, and so not tested as defects: a preview does not pin what
a later `--yes` removes (each removal is checked afresh instead); an ignored
file created in the instant between Arbor's last look and Git's own removal
goes with the worktree, as it would with `git worktree remove`; cleaning N
worktrees of one repository lists its registrations N times; and errors in
`--json` mode are text on stderr with nothing on stdout.

`helpers.cjs` adds process ownership, async CLI execution, deterministic random
numbers, and repository integrity checks. Those general helpers could move
into the existing fixture builder. `measure.cjs` is stress-specific.

After all processes finish, remove only the dedicated scratch directory:

```sh
rm -rf /tmp/arbor-r5-cli
```
