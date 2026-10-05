"use strict";
const { main, scenario, assert } = require("../helpers.cjs");
main(() => scenario("bug-exits", async (f) => {
  const w = f.repository("projects/repo").worktree("dirty", { modified: true });
  const usage = f.cli("list", "--unknown");
  const refused = f.cli("remove", w.path, "--yes");
  console.log({ usage, refused });
  assert.notEqual(usage.status, refused.status, "usage and refused removal need distinguishable exit codes");
}));
