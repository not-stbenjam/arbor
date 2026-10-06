"use strict";
const { main, scenario, assert } = require("../helpers.cjs");
main(() => scenario("bug-json", async (f) => {
  const w = f.repository("projects/repo").worktree("dirty", { modified: true });
  const failures = [];
  for (const args of [
    ["list", "--path", f.path("missing"), "--json"], ["remove", "--json"],
    ["remove", w.path, "--yes", "--json"], ["clean", "--json", "--force"],
    ["stats", "--json", "--host=-bad"], ["list", "--json", "--unknown"],
    ["version", "--json"], ["completion", "bash", "--json"], ["gui", "--json"],
  ]) {
    const r = f.cli(...args); assert.notEqual(r.status, 0); console.log({ args, ...r });
    try { JSON.parse(r.stdout); } catch { failures.push(args); }
  }
  assert.deepEqual(failures, [], "JSON errors need a structured stdout result");
}));
