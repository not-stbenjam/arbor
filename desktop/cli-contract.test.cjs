"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseReport, progressEvent, scanOptions } = require("./protocol.cjs");
const { WorkspaceCache } = require("./workspace-cache.cjs");

test(
  "real Go reports with long commit subjects survive live, progress, and disk cache boundaries",
  { timeout: 120000 },
  async (t) => {
    const fixture = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "arbor-contract-")),
    );
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const repo = path.join(fixture, "repository");
    const linked = path.join(fixture, "linked");
    const home = path.join(fixture, "home");
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    const binary = path.join(fixture, "arbor");
    const build = spawnSync("go", ["build", "-o", binary, "./cmd/arbor"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      timeout: 90000,
    });
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr);
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    function git(...args) {
      const result = spawnSync("git", ["-C", repo, ...args], {
        env,
        encoding: "utf8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    git("init", "-b", "main");
    git("config", "user.name", "Arbor contract test");
    git("config", "user.email", "contract@example.invalid");
    git("commit", "--allow-empty", "-m", "x".repeat(4100));
    git("worktree", "add", "-b", "topic", linked);
    const result = spawnSync(
      binary,
      ["list", "--path", fixture, "--linked-only", "--json", "--progress"],
      {
        env,
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const raw = JSON.parse(result.stdout);
    assert.equal(raw.worktrees.length, 1);
    assert.equal(raw.worktrees[0].subject.length, 4100);
    const report = parseReport(result.stdout);
    const row = report.worktrees[0];
    assert.equal(row.subject.length, 4096);
    for (const key of [
      "id",
      "path",
      "head",
      "branch",
      "canRemove",
      "canDiscard",
      "recommended",
    ])
      assert.equal(row[key], raw.worktrees[0][key]);
    const progress = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("@arbor-progress "))
      .map((line) =>
        progressEvent(JSON.parse(line.slice("@arbor-progress ".length))),
      )
      .find(
        (event) => event.worktree?.path === linked && event.worktree.subject,
      );
    assert.ok(
      progress,
      "completed inspection must reach the progress consumer",
    );
    assert.equal(progress.worktree.subject, row.subject);
    assert.equal(progress.worktree.canRemove, false);
    const filename = path.join(fixture, "workspace-cache.json");
    const options = scanOptions({ root: fixture });
    const cache = await WorkspaceCache.open(filename);
    cache.put(options, raw);
    await cache.pending;
    // Also load a pre-normalization cache such as one written by v0.1.9.
    fs.writeFileSync(
      filename,
      JSON.stringify({ version: 1, entries: [{ options, report: raw }] }),
    );
    const restored = await WorkspaceCache.open(filename);
    assert.deepEqual(restored.get(options), report);
    await restored.pending;

    for (const scenario of [
      "copied-repository",
      "reused-path",
      "verbose-fetch",
    ]) {
      const directory = path.join(fixture, scenario);
      const primary = path.join(directory, "primary");
      const checkout = path.join(directory, "checkout");
      fs.mkdirSync(primary, { recursive: true });
      git("-C", primary, "init", "-b", "main");
      git("-C", primary, "config", "user.name", "Arbor contract test");
      git("-C", primary, "config", "user.email", "contract@example.invalid");
      git("-C", primary, "commit", "--allow-empty", "-m", "Fixture");
      git("-C", primary, "worktree", "add", "-b", "topic", checkout);
      if (scenario === "copied-repository") {
        fs.cpSync(primary, path.join(directory, "backup"), { recursive: true });
      } else if (scenario === "reused-path") {
        fs.renameSync(checkout, path.join(directory, "moved-checkout"));
        const other = path.join(directory, "other");
        git("clone", primary, other);
        git("-C", other, "worktree", "add", "-b", "other-topic", checkout);
      } else {
        for (let i = 0; i < 30; i++)
          git(
            "-C",
            primary,
            "remote",
            "add",
            `missing-${i}`,
            path.join(directory, `absent-${i}-` + "x".repeat(200)),
          );
      }
      const scanned = spawnSync(
        binary,
        [
          "list",
          "--path",
          directory,
          "--linked-only",
          "--json",
          ...(scenario === "verbose-fetch" ? ["--fetch"] : []),
        ],
        {
          env,
          encoding: "utf8",
          timeout: 30000,
        },
      );
      assert.ifError(scanned.error);
      assert.equal(scanned.status, 0, scanned.stderr);
      const source = JSON.parse(scanned.stdout);
      if (scenario === "verbose-fetch") {
        // Thirty remotes fail, each with lines of its own. The warning is
        // the one line that says why, and what the scan relied on instead.
        assert.equal(source.warnings.length, 1, source.warnings.join("\n"));
        const [warning] = source.warnings;
        assert.match(
          warning,
          /^Could not fetch .+ \(.+\)\. Merge checks used the Git data already on disk\.$/,
        );
        assert.ok(!warning.includes("\n") && warning.length < 1024, warning);
      } else {
        assert.equal(
          source.worktrees.filter((item) => item.path === checkout).length,
          2,
          "two repositories register the same checkout path",
        );
      }
      const accepted = parseReport(scanned.stdout);
      assert.equal(accepted.worktrees.length, source.worktrees.length);
      const scan = scanOptions({ root: directory });
      const cacheFile = path.join(directory, "cache.json");
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({
          version: 1,
          entries: [{ options: scan, report: source }],
        }),
      );
      const oldCache = await WorkspaceCache.open(cacheFile);
      assert.deepEqual(oldCache.get(scan), accepted);
      await oldCache.pending;
      oldCache.put(scan, source);
      await oldCache.pending;
      assert.deepEqual(oldCache.get(scan), accepted);
      await oldCache.pending;
    }
  },
);
