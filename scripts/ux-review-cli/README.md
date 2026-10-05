# Reproduce the CLI usability review

These exercises use `scripts/e2e/fixture.cjs`, the real CLI, real disposable Git
repositories, and its local SSH stand-in. They never launch the desktop.
Python 3 provides real pseudo-terminals because `script` is not installed on
the review machine. Bash, Zsh and jq are used by the additional exercises.

```sh
export TMPDIR=/tmp/arbor-r5-uxcli GOTMPDIR=/tmp/arbor-r5-uxcli/go
export GOCACHE=/tmp/arbor-r5-uxcli/cache GOFLAGS='-p=2'
mkdir -p "$GOTMPDIR"
# npm ci first if node_modules is absent.
node scripts/build-desktop.cjs --prepare
node scripts/ux-review-cli/review.cjs
node scripts/ux-review-cli/extra.cjs
node scripts/ux-review-cli/recipes.cjs
node scripts/ux-review-cli/readme.cjs
node scripts/ux-review-cli/installation.cjs
```

Each prints its fixture directory. Its `review.json` records stdout, stderr,
status and arguments; terminal transcripts combine stdout and stderr as a
person sees them. `workspace.cjs` independently rebuilds twelve primary
repositories with 69 linked worktrees, plus a simulated SSH host. It includes
all six loss categories, merged/unmerged/published branches, new checkouts,
locks, detached HEADs, protected branches, missing and empty folders, unreadable
metadata, and spaces/newlines in paths. Metadata is backdated as well as files
so activity spans hours, days and weeks. The extra matrix exercises real
removals at 40, 80, 100 and 200 columns and a changed selection between preview
and execution. `recipes.py` requires the fixture environment and refuses a
CLI outside it; its age-filtered deletion is an exercise, not an atomic age
policy Arbor supports.

`readme.cjs` substitutes fixture paths/hosts in the README's CLI code blocks.
It skips GUI launches. Native macOS installation, real SSH authentication,
Fish loading and AppImage launch are not validated by this harness. The
installation exercise creates an archive with the release script's directory
layout from the built binary; it does not claim to test a downloaded release.

`evidence.json` retains selected before-change observations; use the scripts
for fresh, full transcripts. After all exercises finish, remove only your
review temp directory. Do not run these concurrently with its cleanup.
