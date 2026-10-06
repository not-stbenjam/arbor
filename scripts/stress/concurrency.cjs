"use strict";
const { main, scenario, assert, json, ok, start, integrity, list } = require("./helpers.cjs");
main(() => scenario("concurrency", async (f) => {
  const repo = f.repository("projects/repo");
  for (let i = 0; i < 12; i++) repo.worktree(`w-${i}`);
  const before = list(f).worktrees.length;
  const runs = await Promise.all(Array.from({ length: 3 }, () => start(f, ["clean", "-p", f.root, "--yes", "--json"]).done));
  let successes = 0;
  for (const r of runs) {
    assert.ok([0, 1].includes(r.status));
    const results = JSON.parse(r.stdout); successes += results.filter((x) => x.removed).length;
  }
  const finish = json(f.cli("clean", "-p", f.root, "--yes", "--json")); successes += finish.filter((x) => x.removed).length;
  assert.equal(successes, before); assert.equal(f.statistics().removedWorktrees, before); integrity(f, repo);
  // Different repositories share the same statistics store without sharing
  // cleanup locks, forcing overlapping read-modify-write updates.
  const repos = Array.from({ length: 6 }, (_, i) => f.repository(`projects/r-${i}`, { remote: false }));
  const trees = repos.map((r, i) => r.worktree(`parallel-${i}`));
  const concurrent = trees.map((w) => start(f, ["remove", w.path, "--yes", "--json"]).done);
  for (const r of await Promise.all(concurrent)) assert.equal(json(r).removed, true);
  assert.equal(f.statistics().removedWorktrees, before + trees.length);
  // Git performs ordinary work while Arbor scans and cleans another checkout.
  const busy = repo.worktree("busy", { untracked: true });
  repo.worktree("to-clean");
  const clean = start(f, ["clean", "-p", f.root, "--yes", "--json"]);
  repo.commit("ordinary commit", { where: busy.path });
  const extra = repo.worktree("added", { commits: 1 });
  const scan = start(f, ["list", "-p", f.root, "--json"]);
  repo.git("worktree", "remove", extra.path);
  repo.git("gc", "--prune=never");
  const result = await clean.done; assert.ok([0, 1].includes(result.status)); JSON.parse(result.stdout);
  json(await scan.done);
  assert.ok(f.exists(busy.path)); integrity(f, repo);
}));
