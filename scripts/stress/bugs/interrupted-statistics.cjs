"use strict";
const { main, scenario, assert, fs, quote, start, json } = require("../helpers.cjs");
main(() => scenario("bug-killed-stats", async (f) => {
  const repo = f.repository("projects/repo", { remote: false });
  const first = repo.worktree("a"), second = repo.worktree("b");
  const git = f.run("sh", ["-c", "command -v git"]).stdout.trim();
  const barrier = f.path("barrier");
  // Stop before the second Git removal. The first has fully succeeded, while
  // batch statistics have not yet been written. No Git writer is interrupted.
  f.tool("git", `case "$*" in *'worktree remove'*${quote(second.path)}*) touch ${quote(barrier)}; sleep 30;; esac\nexec ${quote(git)} "$@"`);
  const proc = start(f, ["clean", "--path", f.root, "--yes", "--json"]);
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(barrier) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fs.existsSync(barrier), "second removal was not reached");
    proc.kill("SIGKILL"); await proc.done;
    assert.ok(!f.exists(first.path)); assert.ok(f.exists(second.path));
    fs.unlinkSync(f.path("bin", "git"));
    json(f.cli("clean", "--path", f.root, "--yes", "--json"));
    console.log(f.statistics());
    assert.equal(f.statistics().removedWorktrees, 2, "successful removal before SIGKILL disappeared from statistics");
  } finally { proc.kill(); await proc.done; }
}));
