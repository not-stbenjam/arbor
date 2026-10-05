"use strict";
const { main, scenario, assert, json } = require("../helpers.cjs");
main(() => scenario("bug-private-ref", async (f) => {
  const repo = f.repository("projects/repo"), w = repo.worktree("target", { commits: 1 });
  const precious = f.git(w.path, "rev-parse", "HEAD");
  f.git(w.path, "update-ref", "refs/worktree/precious", precious);
  f.git(w.path, "reset", "--hard", "main");
  // Expire only the shared branch reflog; the private ref remains a durable
  // promise to keep this commit regardless of reflog retention policy.
  repo.git("reflog", "expire", "--expire=now", "refs/heads/target");
  const result = json(f.cli("remove", w.path, "--yes", "--json"));
  assert.equal(result.removed, true);
  // Only this fixture is pruned. The private ref was the last durable owner;
  // its disappearance makes the commit collectible, not merely hidden in UI.
  repo.git("prune", "--expire=now");
  const readable = f.run("git", ["-C", repo.path, "cat-file", "-e", precious + "^{commit}"]);
  console.log({ result, precious, readable });
  assert.equal(readable.status, 0, "unforced removal discarded privately referenced committed work");
}));
