"use strict";
const { main, scenario, assert, fs, list } = require("../helpers.cjs");
main(() => scenario("bug-symlink", async (f) => {
  const repo = f.repository("projects/repo");
  const target = repo.worktree("target"), sibling = repo.worktree("sibling");
  const marker = f.write("projects/sibling/kept.log", "must survive");
  list(f);
  fs.renameSync(target.path, target.path + "-saved"); fs.symlinkSync(sibling.path, target.path);
  const result = f.cli("remove", target.path, "--force", "--yes", "--json");
  console.log(result);
  assert.ok(f.exists(marker), "removal followed the replacement symlink into a sibling");
}));
