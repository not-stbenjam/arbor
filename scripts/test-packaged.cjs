"use strict";

// Runs the distributed application and its real companion CLI on a disposable
// repository. No developer profile, SSH host, or existing checkout is used.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const suffix = process.arch === "arm64" ? "-arm64" : "";
const binary =
  process.argv[2] ||
  path.resolve(
    __dirname,
    "..",
    "dist",
    process.platform === "darwin"
      ? `mac${suffix}/Arbor.app/Contents/MacOS/Arbor`
      : `linux${suffix}-unpacked/arbor-desktop`,
  );
assert.ok(
  fs.existsSync(binary),
  `Build the packaged application first: ${binary}`,
);
const fixture = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "arbor-packaged-")),
);
const projects = path.join(fixture, "projects");
const primary = path.join(projects, "repository");
const home = path.join(fixture, "home");
fs.mkdirSync(primary, { recursive: true });
fs.mkdirSync(home);
const env = {
  ...process.env,
  HOME: home,
  TMPDIR: fixture,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ARBOR_SMOKE_TEST: "1",
  ARBOR_SMOKE_ROOT: projects,
  ARBOR_SMOKE_CLEANUP: "1",
};
function git(...args) {
  const result = spawnSync("git", ["-C", primary, ...args], {
    env,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
try {
  git("init", "-b", "main");
  git("config", "user.name", "Arbor package test");
  git("config", "user.email", "package-test@example.invalid");
  fs.writeFileSync(
    path.join(primary, "tracked.txt"),
    "committed fixture data\n",
  );
  git("add", "tracked.txt");
  git("commit", "-m", "Fixture");
  const head = git("rev-parse", "HEAD");
  const targets = ["old-one", "old-two"].map((name) =>
    path.join(projects, name),
  );
  for (const target of targets)
    git("worktree", "add", "-b", path.basename(target), target, "main");
  fs.writeFileSync(
    path.join(projects, ".arbor-smoke-fixture"),
    "packaged cleanup fixture\n",
  );
  fs.writeFileSync(path.join(projects, "unrelated.txt"), "must remain\n");
  const result = spawnSync(binary, ["--no-sandbox"], {
    env,
    stdio: "inherit",
    timeout: 90000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, "packaged application smoke failed");
  for (const target of targets)
    assert.equal(
      fs.existsSync(target),
      false,
      `linked checkout remained: ${target}`,
    );
  assert.equal(
    fs.readFileSync(path.join(primary, "tracked.txt"), "utf8"),
    "committed fixture data\n",
  );
  assert.equal(
    fs.readFileSync(path.join(projects, "unrelated.txt"), "utf8"),
    "must remain\n",
  );
  assert.equal(git("rev-parse", "HEAD"), head);
  for (const name of ["old-one", "old-two"])
    assert.equal(git("rev-parse", `refs/heads/${name}`), head);
  assert.equal(
    git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length,
    1,
  );
  const profiles = fs
    .readdirSync(fixture)
    .filter((name) => name.startsWith("arbor-smoke-profile-"));
  assert.equal(profiles.length, 1, "one isolated application profile");
  const profile = path.join(fixture, profiles[0]);
  const cache = JSON.parse(
    fs.readFileSync(path.join(profile, "workspace-cache.json"), "utf8"),
  );
  const cached = cache.entries.find((entry) => entry.report.root === projects);
  assert.ok(cached, "completed cleanup snapshot persisted to disk");
  assert.deepEqual(
    cached.report.worktrees,
    [],
    "removed worktrees must not return on restart",
  );
  assert.ok(Number.isFinite(Date.parse(cached.report.scannedAt)));
  const statistics = JSON.parse(
    fs.readFileSync(path.join(profile, "statistics.json"), "utf8"),
  );
  assert.equal(statistics.removedWorktrees, targets.length);
  assert.equal(statistics.cleanupSessions, 1);
  console.log(
    "Packaged application passed: real CLI cleanup, retained branches, primary checkout and unrelated files intact, statistics and cached report verified",
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
