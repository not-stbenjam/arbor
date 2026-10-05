"use strict";
const { main, scenario, assert, fs, quote, json } = require("../helpers.cjs");
main(() => scenario("bug-empty-rmdir", async (f) => {
  const repo = f.repository("projects/repo"), w = repo.worktree("empty");
  fs.renameSync(w.path, w.path + "-saved"); fs.mkdirSync(w.path);
  const git = f.run("sh", ["-c", "command -v git"]).stdout.trim();
  // Refuse only the authorized remover. Arbor must not remove the folder on
  // its own before learning that Git did not perform the requested removal.
  f.tool("git", `case "$*" in *'worktree remove'*) echo 'injected Git removal failure' >&2; exit 1;; esac\nexec ${quote(git)} "$@"`);
  const result = f.cli("remove", w.path, "--repo", repo.path, "--force", "--yes", "--json"); console.log(result);
  assert.notEqual(result.status, 0); assert.ok(f.exists(w.path), "Arbor rmdir removed the empty checkout before Git ran");
}));
