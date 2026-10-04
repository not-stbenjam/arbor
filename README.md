<p align="center"><img src="desktop/common/icon.svg" width="64" alt="Arbor"></p>
<h1 align="center">Arbor</h1>
<p align="center">Your Git worktrees, in one place.</p>
<p align="center">macOS · Linux · Desktop app + portable CLI · Local and SSH hosts</p>
<p align="center"><a href="https://github.com/not-stbenjam/arbor/actions/workflows/ci.yml"><img src="https://github.com/not-stbenjam/arbor/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <a href="https://github.com/not-stbenjam/arbor/releases">Download</a> · <a href="#build-from-source">Build from source</a></p>

Arbor finds linked Git worktrees and lets you delete them. See where they live, which branch they contain, and when they were last active. Delete one checkout or a folder's worktrees. Ordinary repository checkouts are not listed as cleanup items.

The desktop app uses Electron with a native window, system typography, compact controls, and a Go backend. It loads its interface from the app bundle, communicates with the backend through a narrow local bridge, and does not start a web server or open a browser. The same inspection and cleanup engine is available as a small standalone CLI. No account or hosted service is required. Fetching and GitHub checks are optional.

## Download

Choose an asset from [Releases](https://github.com/not-stbenjam/arbor/releases). `VERSION` below includes the `v`, for example `v0.1.0`.

| Platform | Desktop app | Standalone CLI |
| --- | --- | --- |
| macOS, Apple Silicon | `arbor_VERSION_darwin_arm64.app.zip` | `arbor_VERSION_darwin_arm64.tar.gz` |
| macOS, Intel | `arbor_VERSION_darwin_amd64.app.zip` | `arbor_VERSION_darwin_amd64.tar.gz` |
| Linux, x86-64 | `arbor_VERSION_linux_amd64.AppImage` | `arbor_VERSION_linux_amd64.tar.gz` |
| Linux, ARM64 | `arbor_VERSION_linux_arm64.AppImage` | `arbor_VERSION_linux_arm64.tar.gz` |

Linux also has `arbor_VERSION_linux_ARCH.desktop.tar.gz`, an extracted desktop distribution for environments without AppImage/FUSE support. Keep all of its files together.

The desktop supports **macOS 13+** and modern Linux desktops (Ubuntu 22.04 or newer, or an equivalent distribution). It includes its Electron runtime; Node.js is not required to run it. The standalone Go CLI supports macOS 12+ and Linux, has no GUI runtime dependency, and works on headless SSH hosts.

The machine being scanned needs **Git 2.36+**, for [NUL-separated worktree metadata](https://github.com/git/git/blob/master/Documentation/RelNotes/2.36.0.adoc). Optional GitHub PR status requires the [GitHub CLI](https://cli.github.com/) and `gh auth login` on that machine.

### macOS

Unzip the desktop download, drag **Arbor.app** into Applications, and open it. On first launch, a setup wizard lets you choose a local or SSH workspace, scan folder, exclusions, and optional network checks before any scan starts. The app is ad-hoc signed but not Apple-notarized; macOS may require first-launch approval in **System Settings → Privacy & Security → Open Anyway** after attempting to open it. Only approve a download you trust.

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

Add `$HOME/.local/bin` to your shell's `PATH` if needed. `arbor list`, `clean`, and `remove` do not require the desktop app. `arbor` or `arbor gui` launches an installed Arbor desktop app.

### Verify downloads

Every release includes `arbor_VERSION_checksums.txt` with SHA-256 hashes for both CLI and desktop downloads. On Linux, run `sha256sum --check arbor_VERSION_checksums.txt --ignore-missing` from your download folder. On macOS, compare `shasum -a 256 YOUR_DOWNLOAD` with its entry in the checksum file.

## Scanning

Arbor discovers Git repositories beneath your chosen folder and lists their linked worktrees. Both the GUI and CLI omit primary checkouts and bare repositories by default. Ordinary repositories are used to find linked checkouts, but are not themselves fully inspected. A projects folder is usually faster than your entire home folder. Optional fetching and GitHub verification add network work.

The desktop groups worktrees by their actual directories. Each row shows its path, branch, repository, last activity, and size. Delete a row or use a folder's Delete action for its descendant worktrees. Folder deletion removes only the listed worktrees, not the parent folder or unrelated files. Right-click a row to copy its path, open it in Finder/a file manager, or open a local terminal. Local opening actions are unavailable for SSH worktrees.

The desktop shows worktrees as they are found, with pending checks, the current scan stage and path, elapsed time, and completed counts. Cleanup stays disabled until the complete scan has passed its checks. **Stop scan** cancels the current scan and leaves incomplete results visible; scan again before removing anything.

Setup and **Workspace settings** include editable exclusions. Defaults skip directories named `.cache`, `.Trash`, `node_modules`, `tmp`, and `temp`, plus `~/Library/Caches`, `~/Library/Logs`, `~/.local/share/Trash`, and `~/.codex/.tmp`. Real Codex-managed worktrees in `~/.codex/worktrees` are still included. Existing unmodified default lists gain the Codex temporary-directory exclusion on upgrade; custom lists remain unchanged.

Enter one directory name, path, or glob pattern per line. Patterns are case-sensitive: `*` matches characters within a directory name, `?` matches one character, `[abc]` or `[a-z]` matches a character class, and a whole `**` path component matches zero or more directory levels. A single-name pattern matches directories anywhere below the selected root; a relative path pattern is anchored to that root, and an absolute or `~/` pattern is anchored to that machine's filesystem or home folder. Matching a directory excludes its subtree. Use `~/.codex*/.tmp` to skip temporary folders under both `.codex` and alternate Codex home names; use `**/build` for build folders at any depth. Backslash escapes a literal wildcard. Brace expansion and `!` negation rules are not supported. The explicitly selected root itself is always scanned. Clear the list to disable exclusions.

Exclusions also omit registered worktrees in excluded subtrees. They never skip file checks during deletion. SSH exclusions are resolved on the remote machine.

**Settings** stays pinned below the scrolling repository list. To start over, choose **Settings → Reset to defaults…** and confirm. Arbor stops any active scan, clears its saved settings and scan results, and reopens setup. It does not delete repositories, worktrees, or SSH configuration. Reset is unavailable while worktree cleanup is running.

## CLI

```sh
# Open the installed desktop app.
arbor
arbor gui --path "$HOME/git"

# Discover local worktrees. The default path is your home directory.
arbor list --path "$HOME/git"
arbor list --path "$HOME/git" --json
arbor list --path "$HOME/git" --recommended

# Add an exclusion, or replace the default exclusion list.
arbor list --path "$HOME/git" --exclude archives
arbor list --path "$HOME/git" --no-default-excludes --exclude node_modules

# Quote globs so Arbor—not your shell—matches them, including on SSH hosts.
arbor list --path "$HOME" --exclude '~/.codex*/.tmp'
arbor list --host my-vps --exclude '**/build'

# Stream machine-readable progress to stderr; the final JSON stays on stdout.
arbor list --path "$HOME/git" --json --progress

# Explicitly refresh remote refs and check GitHub pull requests.
arbor list --path "$HOME/git" --fetch --github

# Preview cleanup; --yes is required to remove anything.
arbor clean --path "$HOME/git"
arbor clean --path "$HOME/git" --fetch --github --yes

# Remove an eligible worktree; its local branch is retained.
arbor remove -- /absolute/path/to/worktree  # preview, including local-file warnings
arbor remove --yes -- /absolute/path/to/worktree

# Delete all linked worktrees beneath a folder, including unmerged/local work.
arbor clean --path /absolute/path/to/old-sessions --all       # preview
arbor clean --path /absolute/path/to/old-sessions --all --yes # execute
arbor version
```

Run `arbor help` for details. Put flags before positional paths. `--path` scopes discovery and cleanup: only linked worktrees inside that folder appear. `arbor list --linked-only=false` additionally includes primary checkouts and other registered worktrees for diagnostics, not deletion.

## SSH hosts

Select an SSH host in the app, or use `--host` in the CLI. Arbor detects the remote OS and architecture, downloads the matching CLI for its own release from GitHub, verifies the release SHA-256 checksum, and installs it under the remote user's `~/.cache/arbor/bin/`. Subsequent connections reuse the managed executable. No manual remote app installation, desktop runtime, background service, or listening port is needed.

```sh
arbor gui --host my-vps
arbor list --host my-vps --path /home/dev/projects --json
arbor clean --host my-vps --path /home/dev/projects
```

`--host` accepts an SSH config alias or `user@hostname`. Configure custom ports and identity files in `~/.ssh/config`, and successfully connect with ordinary `ssh` first. Arbor uses existing keys, your agent, and verified host keys; connections are noninteractive. An omitted remote path defaults to the remote user's home.

Both macOS and Linux support ARM64 and x86-64. Git must be installed remotely; install and authenticate `gh` remotely for GitHub checks. Provisioning needs a published release matching the local Arbor version. An unversioned `dev` CLI build cannot provision a remote host.

## Cleanup behavior

Recommendations require evidence of a merge and a fully inspected, removable worktree. Arbor checks ancestry against the default branch and can query GitHub PR metadata when enabled. Remote-tracking refs are local snapshots: the CLI's `published` metadata means a remote-tracking ref contains the current commit; it does not prove the remote currently has it. Use **Fetch** to refresh refs and **GitHub** to query PR status. Failed network checks do not count as merge evidence.

Manual Delete can remove linked worktrees with local changes, ignored files, a Git lock, a detached HEAD, or a default branch checkout. The desktop shows one confirmation with the selected paths and any local-file disposal warning. Folder deletion applies to the worktrees matching the current filters, including collapsed children. **Delete merged** is one-click cleanup of recommendations, without another confirmation. The CLI shows a preview unless `--yes` is supplied; `arbor remove --yes` confirms disposal of that checkout's local files. `arbor clean` removes only recommendations unless `--all` is explicitly supplied. `--keep-local` makes a manual CLI removal refuse local-file disposal.

Removal uses Git's worktree removal command and retains named branches. Detached commits not already reachable from a local or remote-tracking branch are saved on an `arbor/retained/…` recovery branch; CLI results include its name. Arbor checks the exact target again before deletion, including its commit and branch. It never deletes primary repositories or follows a changed path. Nested repositories, submodules, sparse indexes, in-progress Git operations, and unreadable/incomplete checkouts still require resolving the specific problem reported by Git or Arbor.

Successful deletions disappear from the existing list immediately; cleanup does not launch a new full scan. A failed deletion stays visible with its error and refreshes only that worktree so it can be retried. If that inspection also fails, its context menu offers **Retry Inspection**. A full refresh is explicit. Quitting cancels a scan; during deletion, Arbor can finish the current worktree and quit without starting the remaining deletions.

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

## CI and releases

[CI](.github/workflows/ci.yml) tests Go on native macOS and Linux, including the minimum supported Go version. It builds desktop packages on ARM64 and x86-64 runners for both platforms, runs desktop bridge tests, and smoke-tests the real Linux app with a virtual display. Builds are available as workflow artifacts.

Publishing a GitHub Release triggers [Release](.github/workflows/release.yml): tests run first, native desktop jobs and standalone CLI builds run in parallel, and a final job combines all assets, generates one checksum manifest, and uploads them to the release. GitHub's built-in token handles publication; no Apple signing secrets are required. **Run workflow** produces the same downloadable artifacts without publishing a release.

To release, push the version tag and publish its GitHub Release. macOS packages are ad-hoc signed and currently distributed without Apple Developer ID signing or notarization.

## License

[MIT](LICENSE).
