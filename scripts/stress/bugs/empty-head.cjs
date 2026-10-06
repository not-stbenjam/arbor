"use strict";
const { main, scenario, assert } = require("../helpers.cjs");
main(() => scenario("bug-empty-head", async (f) => {
  const repo = f.repository("projects/repo"), w = repo.worktree("target");
  const result = f.cli("remove", w.path, "--head=", "--yes", "--json"); console.log(result);
  assert.ok(f.exists(w.path), "explicit empty --head silently disabled the required-commit check");
}));
