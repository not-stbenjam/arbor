"use strict";
const { main, scenario, assert, json } = require("../helpers.cjs");
main(() => scenario("bug-preview-drift", async (f) => {
  const repo = f.repository("projects/repo");
  const shown = repo.worktree("shown");
  const preview = json(f.cli("clean", "--path", f.root, "--json"));
  assert.deepEqual(preview.worktrees.map((w) => w.path), [shown.path]);
  const unseen = repo.worktree("unseen");
  const result = f.cli("clean", "--path", f.root, "--yes", "--json"); console.log(result);
  assert.ok(f.exists(unseen.path), "clean deleted a worktree absent from the preview");
}));
