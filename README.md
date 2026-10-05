<p align="center"><img src="desktop/common/icon.svg" width="64" alt="Arbor"></p>
<h1 align="center">Arbor</h1>
<p align="center">Your Git worktrees, in one place.</p>
<p align="center">macOS · Linux · Desktop app + portable CLI · Local and SSH hosts</p>
<p align="center"><a href="https://github.com/not-stbenjam/arbor/actions/workflows/ci.yml"><img src="https://github.com/not-stbenjam/arbor/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <a href="https://github.com/not-stbenjam/arbor/releases">Download</a> · <a href="#build-from-source">Build from source</a></p>

Arbor finds linked Git worktrees and lets you delete them. See where they live, which branch they contain, and when they were last active. Delete one checkout or a folder's worktrees. Ordinary repository checkouts are not listed as cleanup items.

The desktop app uses Electron with a native window, system typography, compact controls, and a Go backend. It loads its interface from the app bundle, communicates with the backend through a narrow local bridge, and does not start a web server or open a browser. The same inspection and cleanup engine is available as a small standalone CLI. No account or hosted service is required. Fetching and GitHub checks are optional.

## Download

Choose an asset from [Releases](https://github.com/not-stbenjam/arbor/releases). `VERSION` below includes the `v`, for example `v0.1.0`.

| Platform             | Desktop app                          | Standalone CLI                      |
| -------------------- | ------------------------------------ | ----------------------------------- |
| macOS, Apple Silicon | `arbor_VERSION_darwin_arm64.app.zip` | `arbor_VERSION_darwin_arm64.tar.gz` |
| macOS, Intel         | `arbor_VERSION_darwin_amd64.app.zip` | `arbor_VERSION_darwin_amd64.tar.gz` |
| Linux, x86-64        | `arbor_VERSION_linux_amd64.AppImage` | `arbor_VERSION_linux_amd64.tar.gz`  |
| Linux, ARM64         | `arbor_VERSION_linux_arm64.AppImage` | `arbor_VERSION_linux_arm64.tar.gz`  |

Linux also has `arbor_VERSION_linux_ARCH.desktop.tar.gz`, an extracted desktop distribution for environments without AppImage/FUSE support. Keep all of its files together.

The desktop supports **macOS 13+** and modern Linux desktops (Ubuntu 22.04 or newer, or an equivalent distribution). It includes its Electron runtime; Node.js is not required to run it. The standalone Go CLI supports macOS 12+ and Linux, has no GUI runtime dependency, and works on headless SSH hosts.

The machine being scanned needs **Git 2.36+**, for [NUL-separated worktree metadata](https://github.com/git/git/blob/master/Documentation/RelNotes/2.36.0.adoc). Optional GitHub PR status requires the [GitHub CLI](https://cli.github.com/) and `gh auth login` on that machine.

### macOS

Unzip the desktop download, drag **Arbor.app** into Applications, and open it. On first launch, a setup wizard lets you choose this computer or an SSH host, the folder to scan, folders to skip, and optional network checks before any scan starts. The app is ad-hoc signed but not Apple-notarized; macOS may require first-launch approval in **System Settings → Privacy & Security → Open Anyway** after attempting to open it. Only approve a download you trust.

The included backend is also usable from Terminal:

```sh
/Applications/Arbor.app/Contents/Resources/bin/arbor-cli list --path "$HOME/git"
```

For an `arbor` command on your shell's `PATH`, install the standalone CLI as described below. If Git is missing, `xcode-select --install` installs Apple's command line tools.

### Linux

Make the AppImage executable and open it:

```sh
chmod +x arbor_v0.1.0_linux_amd64.AppImage
./arbor_v0.1.0_linux_amd64.AppImage
```

Use the ARM64 asset on ARM hardware. If AppImage cannot mount on your distribution, use the `.desktop.tar.gz` download, extract it, and run `./arbor-desktop` from that folder. Keep its `resources/` directory alongside the executable. Linux desktop builds depend on the standard desktop libraries provided by supported distributions.

### Standalone CLI

Extract the matching CLI archive and run its `arbor` executable directly, or run this from the extracted folder:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 arbor "$HOME/.local/bin/arbor"
```

Add `$HOME/.local/bin` to your shell's `PATH` if needed. `arbor list`, `clean`, and `remove` do not require the desktop app. Running `arbor` shows command help; `arbor gui` explicitly launches an installed Arbor desktop app.

### Verify downloads

Every release includes `arbor_VERSION_checksums.txt` with SHA-256 hashes for both CLI and desktop downloads. On Linux, run `sha256sum --check arbor_VERSION_checksums.txt --ignore-missing` from your download folder. On macOS, compare `shasum -a 256 YOUR_DOWNLOAD` with its entry in the checksum file.

## Scanning

Arbor discovers Git repositories beneath your chosen folder and lists their linked worktrees. Both the GUI and CLI omit primary checkouts and bare repositories by default. Ordinary repositories are used to find linked checkouts, but are not themselves fully inspected. A projects folder is usually faster than your entire home folder. Optional fetching and GitHub verification add network work.

The desktop groups worktrees by their actual directories. Each row leads with the worktree's name, then its branch and repository, last activity, and size; the folder rows above it give the rest of its path, which is also its tooltip and one **Copy path** away. A row names the one fact that most affects cleanup, when there is one: **Merged**, **New**, **Locked**, changed files, ignored files, a missing folder, or the reason it cannot be deleted. Green **Merged** marks exactly the rows **Delete recommended** removes. Delete a row, or point at a folder row for its **Delete…**, which deletes the worktrees shown beneath it and keeps the folder itself and anything else in it. Right-click a row, or press Enter on it, to copy its path, open it in Finder or a file manager, or open a terminal there. Opening actions are unavailable for SSH worktrees.

Arrow keys move through the list, Shift and Ctrl/Cmd extend the selection, Enter opens a row's actions, Delete removes the selection after confirmation, and Escape clears it. Tab moves between the list and its folders rather than through every row's buttons, and when a row is deleted the keyboard stays on the row that takes its place. `/` or Ctrl/Cmd+F focuses the filter. The sort menu's arrow button reverses the order, as clicking a column heading does.

The desktop scans in the background, with independent progress and **Stop** controls for each host. Previously checked worktrees remain usable during a refresh; newly discovered rows show pending checks until their scan completes. Deleting a checked worktree stops and settles a refresh on that host before removing the selected target. Scans on other hosts continue. Stopping a scan keeps its previous checked results and any incomplete discoveries visible; incomplete discoveries cannot be deleted until checked.

Setup and **Settings** include an editable **Folders to skip** list, folded away until opened. Defaults skip directories named `.cache`, `.Trash`, `node_modules`, `tmp`, and `temp`, plus `~/Library/Caches`, `~/Library/Logs`, `~/.local/share/Trash`, `~/.codex/.tmp`, and the rootless container image stores `~/.local/share/containers` and `~/.local/share/docker`, which can hold tens of thousands of directories and no worktrees. Real Codex-managed worktrees in `~/.codex/worktrees` are still included. An unmodified default list gains new default exclusions on upgrade; custom lists, including a default list you trimmed, remain unchanged.

Enter one directory name, path, or glob pattern per line. Patterns are case-sensitive: `*` matches characters within a directory name, `?` matches one character, `[abc]` or `[a-z]` matches a character class, and a whole `**` path component matches zero or more directory levels. A single-name pattern matches directories anywhere below the selected root; a relative path pattern is anchored to that root, and an absolute or `~/` pattern is anchored to that machine's filesystem or home folder. Matching a directory excludes its subtree. Use `~/.codex*/.tmp` to skip temporary folders under both `.codex` and alternate Codex home names; use `**/build` for build folders at any depth. Backslash escapes a literal wildcard. Brace expansion and `!` negation rules are not supported. The explicitly selected root itself is always scanned. Clear the list to disable exclusions.

Skipped folders also omit registered worktrees inside them. They only affect what is searched: files inside a listed worktree are still measured, and are deleted with it. On an SSH host the rules are resolved on that host.

**Settings** stays pinned below the scrolling repository list. Scan settings apply with **Save & scan**, for the host shown; edits to one host are kept while you look at another's, and a host still holding unsaved edits is shown next rather than dropped. Appearance applies as soon as it is chosen, there or with the toggle beside the version. To start over, choose **Settings → Reset to defaults…** and confirm. Arbor stops any active scan, clears its saved settings and scan results, and reopens setup. It does not delete repositories, worktrees, SSH configuration, or cleanup statistics. Reset is unavailable while worktree cleanup is running.

Arbor remembers each host's last scan across host switches and app restarts. **All hosts** combines them into a host → directory → worktree tree; the host picker filters it without scanning or cancelling background work. Saved results appear immediately, marked with the time they were scanned, and unscanned hosts scan in the background (up to three at a time). **Refresh** scans the selected host, or all idle hosts in the combined view. Settings has its own host selector for editing one host's scan options. A host that cannot be reached is reported once, in the banner, and counted in the status bar; the other hosts' results stay usable. Deletion always rechecks the selected worktree before touching it.

## Statistics

Open **Statistics**, pinned beside Settings, for lifetime cleanup totals and 30-day charts: worktrees deleted, estimated space recovered, cleanups, largest worktree, and average worktree size. Successful deletions from both the desktop app and CLI count. Missing checkout registrations count as cleanups but recover zero bytes; disk space is an estimate, not a measurement of free space.

Statistics belong to each host. The **All hosts** view combines their totals and charts; filtering to one host shows only its history. When a host cannot be reached, the totals say they are partial before any number is shown. Local app and CLI share one store; an SSH host keeps its own totals, including cleanups run directly on that host. View them from the terminal with `arbor stats`, `arbor stats --json`, or `arbor stats --host my-vps`.

Only aggregates and 90 days of daily totals are stored, with no worktree path history, in `arbor/statistics.json` under the operating system's user configuration directory. Writes are atomic and process-locked. Unreadable statistics are preserved in a recoverable `.corrupt-*` backup before recording new totals. Resetting preferences keeps statistics.

On macOS the statistics file is `~/Library/Application Support/arbor/statistics.json`; on Linux it is `${XDG_CONFIG_HOME:-$HOME/.config}/arbor/statistics.json`. To start totals over, close Arbor and any CLI cleanup, then move that file aside as a backup. The desktop scan cache is `workspace-cache.json` in Electron's `Arbor` user-data directory (`~/Library/Application Support/Arbor` on macOS, normally `~/.config/Arbor` on Linux).

## CLI

```sh
# Show useful help without opening the app or scanning anything.
arbor
arbor help list
arbor list --help

# Explicitly open the installed desktop app.
arbor gui --path "$HOME/git"

# Discover local worktrees. The default path is your home directory.
arbor list --path "$HOME/git"
arbor list --path "$HOME/git" --json
arbor list --path "$HOME/git" --recommended
arbor list -p "$HOME/git" -q  # quiet: omit human progress

# Add an exclusion, or replace the default exclusion list.
arbor list --path "$HOME/git" --exclude archives
arbor list --path "$HOME/git" --no-default-excludes --exclude node_modules
arbor clean -p "$HOME/git" --exclude 'archives,old'  # commas are literal

# Quote globs so Arbor—not your shell—matches them, including on SSH hosts.
arbor list --path "$HOME" --exclude '~/.codex*/.tmp'
arbor list --host my-vps --exclude '**/build'

# Human scans show progress on stderr. JSON output is quiet unless requested.
# Stream machine-readable progress to stderr; the final JSON stays on stdout.
arbor list --path "$HOME/git" --json --progress

# Explicitly refresh remote refs and check GitHub pull requests.
arbor list --path "$HOME/git" --fetch --github

# Preview cleanup; --yes is required to remove anything.
arbor clean --path "$HOME/git"
arbor clean --path "$HOME/git" --fetch --github --yes

# Remove one worktree; its local branch is kept.
arbor remove -- /absolute/path/to/worktree  # preview, including what --force would discard
arbor remove /absolute/path/to/worktree --yes

# Like git worktree remove, --yes alone refuses a worktree with local files or
# a lock. --force discards them, and removes detached, missing or empty ones.
arbor remove /path/to/worktree --force --yes
arbor remove /missing/worktree --repo /path/to/repository --force --yes

# Delete the clean linked worktrees beneath a folder, merged or not.
arbor clean --path /absolute/path/to/old-sessions --all       # preview
arbor clean --path /absolute/path/to/old-sessions --all --yes # execute
# ...and the ones with local files, locks, or a detached HEAD as well.
arbor clean --path /absolute/path/to/old-sessions --all --force --yes
arbor version
arbor --version
```

The CLI uses Cobra for command-specific help, argument validation, typo suggestions, and shell completion. Run `arbor help COMMAND` or `arbor COMMAND --help` for flags and examples. Help never scans or launches the desktop. Flags can appear before or after a positional worktree path; use `--` before a path beginning with `-`. Short forms include `-p` for `--path`, `-y` for `--yes`, and `-q` for `--quiet`.

`--path` scopes discovery and cleanup: only linked worktrees inside that folder appear. `arbor list --linked-only=false` additionally includes primary checkouts and other registered worktrees for diagnostics, not deletion. Repeat `--exclude` to add multiple rules; each argument is one literal pattern, so commas are not separators. Both `list` and `clean` accept exclusions.

Human-readable output names the scanned folder once and lists each worktree's path beneath it, with branch, repository, last activity, size, and status, and explicitly says when no worktrees match. Long branch names keep both ends; `--json` has every value in full. Scans that take longer than a moment report progress on stderr; `--quiet` suppresses it. `--json` writes only the result to stdout; add `--progress` for newline-delimited `@arbor-progress ` JSON events on stderr. Removal and cleanup preview by default, with the total size on disk and, per path, what `--force` would discard; `--yes` is required to delete anything, and never discards local files by itself. Scan warnings and skipped worktrees from `clean` and `remove` always go to stderr, including with `--json`, so an incomplete scan never looks like a folder with nothing to clean; a JSON preview also carries the scan warnings as `warnings`.

### Shell completion

Generate completion for Bash, Zsh, Fish, or PowerShell:

```sh
arbor completion bash
arbor completion zsh
arbor completion fish
arbor completion powershell
```

Run `arbor completion SHELL --help` for installation instructions for your shell. Generating completion does not scan repositories or require the desktop app.

## SSH hosts

Add an SSH host in the app, choosing the folder to scan on it, or use `--host` in the CLI. Arbor detects the remote OS and architecture, downloads the matching CLI for its own release from GitHub, verifies the release SHA-256 checksum, and installs it under the remote user's `~/.cache/arbor/bin/`, publishing it there only after the transfer is complete and the executable runs. Subsequent connections reuse the managed executable. No manual remote app installation, desktop runtime, background service, or listening port is needed.

```sh
arbor gui --host my-vps
arbor list --host my-vps --path /home/dev/projects --json
arbor clean --host my-vps --path /home/dev/projects
```

`--host` accepts an SSH config alias or `user@hostname`. Configure custom ports and identity files in `~/.ssh/config`, and successfully connect with ordinary `ssh` first. Arbor uses existing keys, your agent, and verified host keys; connections are noninteractive, so a host that would prompt for a password or a host key cannot be used. A connection failure says which of those it was. An omitted remote path defaults to the remote user's home.

Both macOS and Linux support ARM64 and x86-64. Git must be installed remotely; install and authenticate `gh` remotely for GitHub checks. Provisioning needs a published release matching the local Arbor version. An unversioned `dev` CLI build cannot provision a remote host.

## Cleanup behavior

Recommendations require evidence of a merge and a fully inspected, removable worktree. Arbor checks ancestry against the default branch and can query GitHub PR metadata when enabled.

One remote decides what is merged: `upstream` when the repository has one, otherwise `origin`. Its default branch is the one it names as its HEAD, or else its `main`, `master`, or `trunk`. **Fetch** also asks that remote again, so a renamed default branch stops deciding what is merged. When that remote cannot say, because an `upstream` was added and never fetched, or its default branch is one this clone does not fetch, nothing in the repository is recommended and a scan warning says why; another remote's branches, or a local one, do not answer for it. A repository with no such remote, and a bare clone, which keeps `origin`'s branches as its own, use their own `main`, `master`, or `trunk`. A merged pull request counts only when it was merged into the deciding remote's default branch on GitHub: one merged into your fork's own branch has not landed upstream.

A worktree created in the last 24 hours whose HEAD has never moved is **New**, not recommended: its branch is an ancestor of the default branch only because it still points at its starting commit, and it may be a checkout you or a coding tool just started using. It becomes a recommendation once its HEAD has moved to merged work or it has sat untouched for a day, and can be deleted manually at any time. This is a narrow guard for a checkout that was only just created, not a test of whether a worktree is in use: any movement of HEAD counts, including a pull or rebase that adds no commits of your own. A repository that keeps no HEAD reflog offers no creation time, so the rule does not apply there.

Remote-tracking refs are local snapshots: the CLI's `published` metadata means a remote-tracking ref contains the current commit; it does not prove the remote currently has it. Use **Fetch** to refresh refs and **GitHub** to query PR status. Failed network checks do not count as merge evidence.

Manual Delete can remove linked worktrees with local changes, ignored files, a Git lock, a detached HEAD, or a default branch checkout. The desktop shows one confirmation that leads with any loss of local files, lists the worktrees that would lose them before the rest, and says that a folder holding them is kept. Folder deletion applies to the worktrees matching the current filters, including collapsed children. **Delete recommended** removes the recommendations the list currently shows, without a dialog; its count follows the repository and search filters, exactly as the list does. Because it sits beside Refresh, its first click only arms it and says exactly what it will delete; a second, separate click within a few seconds does it. A double-click or a held key is one gesture and confirms nothing, and Escape, looking away, or any change to the worktrees it named withdraws the question.

The CLI shows a preview unless `--yes` is supplied. As with `git worktree remove`, `--yes` alone refuses a worktree that has uncommitted, untracked or ignored files, or a lock; `--force` discards those files, overrides the lock, and is what removes a detached, missing or empty checkout, or a linked checkout of the default branch or of `main`, `master`, `trunk` or `develop`. `arbor clean` removes only recommendations; `--all` adds clean worktrees that are not merged, and `--all --force` adds the rest.

Removal uses Git's worktree removal command and retains named branches. Detached commits not already reachable from a local or remote-tracking branch are saved on an `arbor/retained/…` recovery branch; CLI results include its name. Arbor checks the exact target again before deletion, including its commit and branch. Because inspecting a large checkout takes long enough for it to change, the last step before Git removes the folder confirms it is still the same folder at the same commit and branch. That narrows the window to moments but cannot close it: Arbor does not lock other Git processes out of a worktree, so do not delete one that something is committing to right then. It never deletes primary repositories or follows a changed path. Nested repositories, submodules, sparse indexes, in-progress Git operations, and unreadable/incomplete checkouts still require resolving the specific problem reported by Git or Arbor.

Missing checkout registrations, including locked ones, can be removed individually; Arbor does not run a global prune. An empty leftover directory with no Git pointer can also be removed explicitly, but only while it remains empty. Neither case removes unrelated registrations. For a missing path outside its repository, supply `--repo` so the CLI can locate the registration without a broad scan.

Successful deletions disappear from the existing list immediately, with a notice of how many went and about how much space they held; cleanup does not launch a new full scan. A failed deletion stays visible with its error and refreshes only that worktree so it can be retried. If that inspection also fails, its menu offers **Check again**. A full refresh is explicit. Quitting cancels a scan; during deletion, Arbor can finish the current worktree and quit without starting the remaining deletions.

Deleted checkouts are not moved to Trash. Committed work can be checked out again with `git worktree add PATH BRANCH`; discarded uncommitted, untracked, and ignored files cannot be recovered through Git.

**Last activity** is estimated from the commit, worktree file modification times, and Git metadata. **Disk usage** counts regular checkout files, not shared Git objects, and is not an exact promise of reclaimed space. Discovery does not follow directory symlinks. Permission problems and incomplete scans are reported.

## Build from source

Install **Go 1.24+**, **Node.js 22.12+**, Git, and Make. The same commands work on macOS and Linux:

```sh
git clone https://github.com/not-stbenjam/arbor.git
cd arbor
npm ci
npm start
```

`npm start` builds the Go companion and icons automatically, then opens the desktop app. There is no renderer bundler or framework build step. All assets are local. `npm run desktop:dir` builds an unpacked desktop distribution in `dist/`.

```sh
make build                            # standalone Go CLI in bin/arbor
make install                          # install CLI into ~/.local/bin
make check                            # Go vet and race tests
npm run test:desktop                  # backend/desktop bridge tests
make package VERSION=v0.1.0           # standalone CLI archives, all 4 platforms
make desktop-package VERSION=v0.1.0   # desktop app for this OS + architecture
```

CLI packaging needs Go and `tar`, can cross-compile all four targets from either OS, and keeps `CGO_ENABLED=0`. Desktop packaging uses pinned Electron/electron-builder dependencies, builds the matching Go companion, and produces a macOS `.app.zip` or Linux AppImage and desktop archive. Build macOS packages on macOS. Outputs go into `dist/`.

The release tag is embedded in the backend (for example `v0.1.0`) and the corresponding numeric version in the desktop app (`0.1.0`). Set `ARBOR_VERSION=v0.1.0` for direct npm packaging commands; otherwise the version comes from `package.json`.

## Code organization

Each layer owns its state and exposes commands or snapshots to its callers:

| Layer | Responsibility |
| --- | --- |
| `internal/worktree` | Scan preparation, repository registration collection, bounded inspection workers, checkout evidence, typed removal decisions, and process-owned cleanup locks. Removal takes named options and rechecks its target. |
| `internal/engine` | The same scan/removal contract locally or over SSH, with separate transport, provisioning, download coordination, and archive verification. |
| `cmd/arbor` | Cobra input, pure request normalization and target selection, batch execution, result presentation, and per-machine statistics recording. |
| `internal/stats`, `desktop/workspace-cache.cjs` | Aggregate cleanup history and reusable scan snapshots, respectively. Neither owns deletion policy. |
| `desktop/backend.cjs`, `desktop/live-worktrees.cjs` | One host's operation lifecycle and snapshots, and the rows shown while its scan is still running. Callers issue commands rather than mutate Backend state. |
| `desktop/workspace-coordinator.cjs`, `desktop/host-scheduler.cjs`, `desktop/workspace-snapshot.cjs` | Host routing and lifecycle, bounded background scheduling, and host-scoped identities/revisions and combined reports. Filtering never performs I/O. |
| `desktop/main.cjs` | Electron composition. IPC, application/context menus, native window lifecycle, and subprocess execution have separate adapters. |
| `desktop/preferences-store.cjs` | Serialized preference persistence with one scan-settings writer, including remembered host roots. |
| `desktop/removal-policy.cjs`, `desktop/removal-confirmation.cjs`, `desktop/cleanup-batch.cjs` | Pure removal selection and consent planning; the native confirmation's wording; sequential execution of approved targets. Batch execution reports outcomes without owning application snapshots or caches. |
| `desktop/renderer`, `desktop/common` | Workspace, preferences, setup, and statistics controllers; tree interaction and presentation are separate. `app.js` only connects them. Renderer code is ES modules loaded directly, with no bundler; `desktop/common` holds the modules the main process and tests share with it. |
| `desktop/protocol.cjs`, `internal/config` | Shared desktop report validation and one authoritative exclusion defaults/limits document embedded by Go and loaded by Electron. |

Tests exercise the named interfaces rather than reaching into operation state. Pure selection, policy, and presentation tests complement real Git fixtures, Go-to-desktop wire contract checks, and Electron workflows. Renderer snapshots are immutable; checkout identity stays intact when long display metadata is shortened.

## CI and releases

[CI](.github/workflows/ci.yml) tests Go on native macOS and Linux, including the minimum supported Go version. It builds desktop packages on ARM64 and x86-64 runners for both platforms. Packaged-app tests use the real companion CLI to remove marked disposable worktrees, checking retained branches, untouched primary checkouts, statistics, and cache updates without rescanning. Linux uses a virtual display; macOS also runs native close-lifecycle checks. Builds are available as workflow artifacts.

Publishing a GitHub Release triggers [Release](.github/workflows/release.yml): tests run first, native desktop jobs and standalone CLI builds run in parallel, and a final job combines all assets, generates one checksum manifest, and uploads them to the release. GitHub's built-in token handles publication; no Apple signing secrets are required. **Run workflow** produces the same downloadable artifacts without publishing a release.

To release, push the version tag and publish its GitHub Release. macOS packages are ad-hoc signed and currently distributed without Apple Developer ID signing or notarization.

## License

[MIT](LICENSE).
