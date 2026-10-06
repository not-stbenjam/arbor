# Arbor for Homebrew

This tap installs [Arbor](https://github.com/stbenjam/arbor), a command-line
program and desktop app for managing Git worktrees. The CLI supports macOS
and Linux on Intel and ARM64; the desktop cask requires macOS 13 or newer.
The machine being scanned needs Git 2.36 or newer.

Install the CLI:

```sh
brew install stbenjam/arbor/arbor
```

Install the macOS app:

```sh
brew install --cask stbenjam/arbor/arbor
```

Arbor is ad-hoc signed, but not yet signed with an Apple Developer ID or
notarized. macOS will refuse to open it the first time. After trying to open
it, go to **System Settings → Privacy & Security → Open Anyway**.
Only approve a download you trust.

Upgrade either installation:

```sh
brew update
brew upgrade --formula stbenjam/arbor/arbor
brew upgrade --cask stbenjam/arbor/arbor
```

Uninstall either installation:

```sh
brew uninstall --formula stbenjam/arbor/arbor
brew uninstall --cask stbenjam/arbor/arbor
```

Uninstalling keeps local preferences and statistics. To remove those too,
back up your statistics first and use
`brew uninstall --cask --zap stbenjam/arbor/arbor`. This also removes statistics
shared with the CLI. Repositories, worktrees and remote files are left alone.
