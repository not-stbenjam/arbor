"use strict";

// Real Git repositories and linked worktrees for tests, built inside one
// folder made for the purpose. Everything Arbor and Git read or write while a
// test runs (home folder, configuration, statistics, temporary files, SSH
// hosts) is beneath that folder, so a test can delete for real and nothing
// that belongs to the person running it is ever looked at.
//
//   const fixture = createFixture(directory);
//   const alpha = fixture.repository("projects/alpha");
//   alpha.worktree("merged");                       // clean, established, recommended
//   alpha.worktree("wip", { commits: 2, modified: true });
//   fixture.cli("list", "--path", fixture.root, "--json");
//
// See the options beside `repository`, `worktree` and `host` below.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOUR = 3600 * 1000;
const REPOSITORY = path.resolve(__dirname, "..", "..");
const PREFIX = "arbor-e2e-";
const TERMINALS = [
  "ptyxis", "kgx", "gnome-terminal", "konsole", "xfce4-terminal", "kitty",
  "alacritty", "foot", "wezterm", "ghostty", "x-terminal-emulator", "xterm",
];

function realCLI() {
  for (const name of ["arbor-cli", "arbor"]) {
    const candidate = path.join(REPOSITORY, "bin", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Build the command-line program first: node scripts/build-desktop.cjs --prepare",
  );
}

// A new, empty folder for one test. Only folders made here are ever removed.
function createDirectory(name) {
  const slug = String(name).replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${slug}-`)),
  );
}

function assertDirectory(directory) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    !path.basename(directory).startsWith(PREFIX)
  )
    throw new Error(`Not a test folder made by this harness: ${directory}`);
  return directory;
}

function removeDirectory(directory) {
  fs.rmSync(assertDirectory(directory), { recursive: true, force: true });
}

// The environment that keeps Git and Arbor inside the test folder.
function environment(directory, base = process.env) {
  assertDirectory(directory);
  const home = path.join(directory, "home");
  const env = { ...base };
  for (const name of Object.keys(env))
    if (/^(GIT_|ARBOR_SMOKE_|SSH_)/.test(name)) delete env[name];
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: path.join(directory, "tmp"),
    GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ARBOR_STATS_PATH: path.join(directory, "statistics.json"),
    ARBOR_CLI_PATH: path.join(directory, "bin", "arbor-cli"),
    ARBOR_E2E_DIRECTORY: directory,
    PATH: `${path.join(directory, "bin")}${path.delimiter}${base.PATH || ""}`,
  };
}

function createFixture(directory) {
  assertDirectory(directory);
  const env = environment(directory);
  const at = (...parts) => {
    const target = path.resolve(directory, ...parts);
    if (target !== directory && !target.startsWith(directory + path.sep))
      throw new Error(`Outside the test folder: ${target}`);
    return target;
  };
  const calls = at("cli-calls.log");

  function prepare() {
    for (const folder of ["home", "tmp", "bin", "projects", "hosts", "user-data"])
      fs.mkdirSync(at(folder), { recursive: true });
    if (fs.existsSync(at("gitconfig"))) return;
    fs.writeFileSync(
      at("gitconfig"),
      [
        "[user]\n\tname = Arbor Test\n\temail = test@example.invalid",
        "[init]\n\tdefaultBranch = main",
        "[commit]\n\tgpgsign = false",
        "[tag]\n\tgpgsign = false",
        // A detached `git maintenance` holds a lock file a test would trip on.
        "[maintenance]\n\tauto = false",
        "[gc]\n\tauto = 0",
        "[advice]\n\tdetachedHead = false",
        '[protocol "file"]\n\tallow = always',
        "",
      ].join("\n"),
    );
    // The real program, behind a wrapper that notes each time it is run.
    tool(
      "arbor-cli",
      `line=$(printf '%s\\037' "$@")\nprintf '%s\\n' "$line" >> ${quote(calls)}\nexec ${quote(realCLI())} "$@"`,
    );
    // Stands in for ssh: the command runs on this computer, with the named
    // host's own home folder, as it would after logging in to that host.
    tool(
      "ssh",
      [
        'while [ $# -gt 0 ]; do case "$1" in --) shift; break;; -o) shift 2;; -*) shift;; *) break;; esac; done',
        'host=$1; shift',
        `hosts=${quote(at("hosts"))}`,
        'printf \'%s\\n\' "$host" >> "$hosts/connections.log"',
        'home="$hosts/$host"',
        'if [ ! -d "$home" ]; then printf \'%s\\n\' "ssh: Could not resolve hostname $host: Name or service not known" >&2; exit 255; fi',
        'if [ -f "$home/.ssh-refuses" ]; then cat "$home/.ssh-refuses" >&2; exit 255; fi',
        'if [ -f "$home/.ssh-delay" ]; then sleep "$(cat "$home/.ssh-delay")"; fi',
        'unset ARBOR_STATS_PATH ARBOR_CLI_PATH',
        'export HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_CACHE_HOME="$home/.cache" XDG_DATA_HOME="$home/.local/share" XDG_STATE_HOME="$home/.local/state"',
        'cd "$home" && exec sh -c "$*"',
      ].join("\n"),
    );
    // GitHub's program is absent unless a test installs its own stand-in.
    tool("gh", 'printf \'%s\\n\' "gh: not installed for this test" >&2; exit 127');
    // Nothing a test chooses from a menu opens a real terminal or file manager.
    for (const name of [...TERMINALS, "xdg-open", "open"])
      tool(
        name,
        `printf '%s\\n' ${quote(name)}" $PWD $*" >> ${quote(at("opened.log"))}`,
      );
  }

  function tool(name, script) {
    const file = at("bin", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return file;
  }

  function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: options.cwd || directory,
      env: { ...env, ...options.env },
      input: options.input,
      encoding: "utf8",
      timeout: options.timeout || 120000,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // Runs Git and returns what it printed. A failure is an error.
  function git(cwd, ...args) {
    return gitWith({}, cwd, ...args);
  }
  function gitWith(extra, cwd, ...args) {
    const result = run("git", ["-C", at(cwd), ...args], { env: extra });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} (in ${cwd}): ${result.stderr}`);
    return result.stdout.trim();
  }
  // Git records these as the time a commit was made or a worktree created.
  const dated = (hoursOld) => {
    const when = new Date(Date.now() - hoursOld * HOUR).toISOString();
    return { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  };

  // Writes a file. A number makes a file of that many bytes.
  function write(relative, content = "") {
    const file = at(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof content === "number") {
      const descriptor = fs.openSync(file, "w");
      const block = Buffer.alloc(Math.min(content, 1 << 20), 0x61);
      for (let left = content; left > 0; left -= block.length)
        fs.writeSync(descriptor, block, 0, Math.min(left, block.length));
      fs.closeSync(descriptor);
    } else fs.writeFileSync(file, content);
    return file;
  }
  const writeAll = (folder, files = {}) =>
    Object.entries(files).map(([name, content]) =>
      write(path.join(folder, name), content),
    );

  // Sets when everything in a folder was last changed, the folder included.
  function backdate(folder, hoursOld) {
    const when = new Date(Date.now() - hoursOld * HOUR);
    const visit = (target) => {
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory())
        for (const name of fs.readdirSync(target)) visit(path.join(target, name));
      fs.utimesSync(target, when, when);
    };
    visit(at(folder));
  }

  // A repository with one commit on its default branch.
  //   branch     name of the default branch ("main")
  //   remote     also make a bare repository it pushes to as origin (true)
  //   hoursOld   age of the first commit (720)
  //   files      tracked files, name -> content or size in bytes
  //   ignore     lines of .gitignore (node_modules/, *.log)
  function repository(relative, options = {}) {
    const {
      branch = "main",
      remote = true,
      hoursOld = 720,
      files = {},
      ignore = ["node_modules/", "*.log"],
    } = options;
    const folder = at(relative);
    const name = path.basename(folder);
    fs.mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q", "-b", branch);
    write(path.join(folder, "README.md"), `# ${name}\n`);
    write(path.join(folder, ".gitignore"), ignore.join("\n") + "\n");
    writeAll(folder, files);
    git(folder, "add", "-A");
    gitWith(dated(hoursOld), folder, "commit", "-q", "-m", "Start");
    let origin = "";
    if (remote) {
      origin = path.join(path.dirname(folder), ".remotes", `${name}.git`);
      fs.mkdirSync(path.dirname(origin), { recursive: true });
      git(directory, "init", "-q", "--bare", "-b", branch, origin);
      git(folder, "remote", "add", "origin", origin);
      git(folder, "push", "-q", "-u", "origin", branch);
      git(folder, "remote", "set-head", "origin", branch);
    }
    let count = 0;
    const repo = {
      name,
      path: folder,
      origin,
      branch,
      git: (...args) => git(folder, ...args),
      head: (ref = "HEAD") => git(folder, "rev-parse", ref),
      // Adds a commit in `where` (the repository itself unless given).
      commit(message = "Change", { where = folder, hoursOld = 100, files } = {}) {
        if (files) writeAll(where, files);
        else write(path.join(where, `change-${++count}.txt`), `${message}\n`);
        git(where, "add", "-A");
        gitWith(dated(hoursOld), where, "commit", "-q", "-m", message);
        return git(where, "rev-parse", "HEAD");
      },
      // A linked worktree of this repository. With no options it is clean,
      // was created three days ago and holds nothing the default branch
      // lacks, which is what Arbor recommends deleting.
      //   at         where, relative to the test folder (beside the repository)
      //   branch     its branch (the worktree's name, made fit for a branch)
      //   from       what it starts from (the default branch)
      //   detached   check out a commit rather than a branch
      //   hoursOld   how long ago it was created (72); 0 is "just now"
      //   commits    commits of its own, not in the default branch (0)
      //   merged     merge those commits into the default branch: true or "squash"
      //   pushed     push its branch to origin
      //   modified   change a tracked file without committing
      //   untracked  files Git does not know: true, or name -> content/size
      //   ignored    ignored files, name -> content/size ({"node_modules/a.bin": 1e6})
      //   files      committed files, name -> content/size
      //   locked     lock it: true, or the reason as text
      //   missing    delete its folder behind Git's back
      worktree(name, options = {}) {
        const {
          // A folder may be named what a branch may not.
          branch: topic = name.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, ""),
          from = branch,
          detached = false,
          hoursOld = 72,
          commits = 0,
          merged = false,
          pushed = false,
          modified = false,
          untracked = false,
          ignored = null,
          files = null,
          locked = false,
          missing = false,
        } = options;
        const target = at(options.at || path.join(path.dirname(folder), name));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const when = dated(hoursOld);
        gitWith(
          hoursOld > 0 ? when : {},
          folder,
          "worktree",
          "add",
          "-q",
          ...(detached ? ["--detach"] : ["-b", topic]),
          target,
          from,
        );
        if (files) repo.commit("Add files", { where: target, hoursOld, files });
        for (let index = 0; index < commits; index++)
          repo.commit(`${name} ${index + 1}`, { where: target, hoursOld });
        if (pushed && !detached && origin)
          git(target, "push", "-q", "-u", "origin", topic);
        if (merged && !detached) {
          if (merged === "squash") {
            git(folder, "merge", "-q", "--squash", topic);
            gitWith(when, folder, "commit", "-q", "-m", `${name} (squashed)`);
          } else
            gitWith(when, folder, "merge", "-q", "--no-ff", "-m", `Merge ${name}`, topic);
          if (origin) git(folder, "push", "-q", "origin", branch);
        }
        // Files Git has just written would make the worktree look used a
        // moment ago; date them as old as the worktree itself.
        if (hoursOld > 0) {
          backdate(target, hoursOld);
          // Git's own record of the worktree is dated too.
          backdate(git(target, "rev-parse", "--absolute-git-dir"), hoursOld);
        }
        if (modified)
          fs.appendFileSync(path.join(target, "README.md"), "\nedited, not committed\n");
        if (untracked)
          writeAll(target, untracked === true ? { "notes.txt": "not added\n" } : untracked);
        if (ignored) writeAll(target, ignored);
        if (locked)
          git(
            folder,
            "worktree",
            "lock",
            ...(typeof locked === "string" ? ["--reason", locked] : []),
            target,
          );
        if (missing) fs.rmSync(at(target), { recursive: true, force: true });
        return { name, path: target, branch: detached ? "" : topic, repository: repo };
      },
    };
    return repo;
  }

  // An SSH host that is really a folder on this computer: `ssh <name>` runs
  // there with that folder as its home. Repositories for it go beneath
  // `host.root` ("hosts/<name>/projects"); Arbor can be given that folder or
  // "~/projects".
  //   seeded       Arbor's remote program is already installed there (true).
  //                Without it Arbor would try to download a release.
  function host(name, { seeded = true } = {}) {
    const home = at("hosts", name);
    fs.mkdirSync(path.join(home, "projects"), { recursive: true });
    if (seeded) {
      const version = run(realCLI(), ["--version"]).stdout.trim().split(" ")[1];
      const system = process.platform;
      const architecture = { x64: "amd64", arm64: "arm64" }[process.arch];
      const binary = path.join(home, ".cache", "arbor", "bin", version, `${system}_${architecture}`, "arbor");
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.copyFileSync(realCLI(), binary);
      fs.chmodSync(binary, 0o700);
    }
    return {
      name,
      home,
      root: path.join(home, "projects"),
      relative: (...parts) => path.join("hosts", name, ...parts),
      // Makes every connection fail with this message, as ssh would print it.
      refuse: (message = `ssh: connect to host ${name} port 22: Connection refused`) =>
        fs.writeFileSync(path.join(home, ".ssh-refuses"), message + "\n"),
      accept: () => fs.rmSync(path.join(home, ".ssh-refuses"), { force: true }),
      // Makes every connection wait this many seconds first.
      delay: (seconds) =>
        seconds
          ? fs.writeFileSync(path.join(home, ".ssh-delay"), String(seconds))
          : fs.rmSync(path.join(home, ".ssh-delay"), { force: true }),
    };
  }

  // What the desktop application remembers. Leave it unwritten to start at
  // first-run setup.
  function preferences(value = {}) {
    const root = value.scan?.root ?? at("projects");
    const saved = {
      setupCompleted: true,
      theme: "light",
      roots: [root],
      hosts: [],
      ...value,
      scan: { root, host: "", github: false, fetch: false, excludes: [], ...value.scan },
    };
    write("user-data/preferences.json", JSON.stringify(saved, null, 2));
    return saved;
  }

  const lines = (file) =>
    fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      : [];

  prepare();
  return {
    directory,
    root: at("projects"),
    home: at("home"),
    env,
    path: at,
    tool,
    run,
    git,
    gitWith,
    dated,
    backdate,
    write,
    read: (relative) => fs.readFileSync(at(relative), "utf8"),
    exists: (relative) => fs.existsSync(at(relative)),
    repository,
    host,
    preferences,
    // Runs the real command-line program in this fixture.
    cli: (...args) => run(at("bin", "arbor-cli"), args),
    // The arguments of each run of the command-line program so far, the
    // application's own runs included.
    cliCalls: () => lines(calls).map((line) => line.split("\x1f").slice(0, -1)),
    // The hosts ssh was asked to connect to, in order.
    connections: () => lines(at("hosts", "connections.log")),
    // What would have been opened: "<program> <folder> <arguments>".
    opened: () => lines(at("opened.log")),
    statistics: () =>
      fs.existsSync(env.ARBOR_STATS_PATH)
        ? JSON.parse(fs.readFileSync(env.ARBOR_STATS_PATH, "utf8"))
        : null,
  };
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  createDirectory,
  removeDirectory,
  assertDirectory,
  createFixture,
  environment,
  realCLI,
  REPOSITORY,
};
