"use strict";
const { main, scenario, assert, ok } = require("./helpers.cjs");
main(() => scenario("confirmation", async (f) => {
  const repo = f.repository("projects/repo");
  const trees = [repo.worktree("clean"), repo.worktree("dirty", { modified: true })];
  for (const input of ["yes\n", "y\n", "YES\n", "--yes\n", "\n", "yes\nyes\n"]) {
    for (const args of [["clean", "--path", f.root], ["clean", "--path", f.root, "--all", "--force"], ...trees.map((w) => ["remove", w.path, "--force"])]) {
      ok(f.run(f.env.ARBOR_CLI_PATH, args, { input }));
      for (const w of trees) assert.ok(f.exists(w.path), `${args} consumed stdin as consent`);
    }
  }
  assert.equal(f.statistics(), null);
}));
