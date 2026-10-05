"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fixture = require("../e2e/fixture.cjs");
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function scenario(name, test) {
  const directory = fixture.createDirectory(`stress-${name}`);
  try { await test(fixture.createFixture(directory)); }
  finally { fixture.removeDirectory(directory); }
}
function ok(result) {
  assert.equal(result.status, 0, JSON.stringify(result));
  return result;
}
function json(result) { return JSON.parse(ok(result).stdout); }
function list(f, ...args) { return json(f.cli("list", "--path", f.root, "--json", ...args)); }
function entry(f, tree) { return list(f).worktrees.find((w) => w.path === tree.path); }
function random() {
  const seed = Number(process.env.STRESS_SEED || 20261005) >>> 0;
  console.log(`seed=${seed}`);
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
// Own a process group, including Git/SSH children, so a failing test leaves none.
function start(f, args, options = {}) {
  const child = spawn(options.command || f.env.ARBOR_CLI_PATH, args, {
    cwd: f.directory, env: { ...f.env, ...options.env }, detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (s) => { stdout += s; options.output?.(String(s), false, child); });
  child.stderr.on("data", (s) => { stderr += s; options.output?.(String(s), true, child); });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input || "");
  const kill = (signal = "SIGKILL") => { if (!child.pid) return; try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; } };
  const timer = setTimeout(() => kill(), options.timeout || 120000);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  }).finally(() => { clearTimeout(timer); kill(); });
  return { child, done, kill };
}
function integrity(f, repo) {
  f.git(repo.path, "fsck", "--full");
  const raw = repo.git("worktree", "list", "--porcelain", "-z");
  for (const record of raw.split("\0\0")) {
    const target = record.split("\0").find((s) => s.startsWith("worktree "))?.slice(9);
    if (target) assert.ok(fs.existsSync(target), `registered checkout missing: ${target}`);
  }
  function visit(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      assert.ok(!e.name.endsWith(".lock"), `leftover Git lock: ${file}`);
      if (e.isDirectory()) visit(file);
    }
  }
  visit(path.join(repo.path, ".git"));
  if (f.statistics()) assert.equal(f.statistics().version, 1);
  // Persistent flock files are intentional. Prove no process still owns them.
  const locks = [path.join(repo.path, ".git", "arbor-cleanup.flock"), f.env.ARBOR_STATS_PATH + ".lock"].filter((p) => fs.existsSync(p));
  if (locks.length) ok(f.run("python3", ["-c", "import fcntl,sys\nfor name in sys.argv[1:]:\n with open(name,'r+') as f: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n", ...locks]));
}
function main(test) { test().catch((error) => { console.error(error); process.exitCode = 1; }); }
module.exports = { ...fixture, assert, fs, path, quote, scenario, ok, json, list, entry, random, start, integrity, main };
