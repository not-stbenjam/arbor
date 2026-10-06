"use strict";
const { main, scenario, assert, fs, path, json } = require("../helpers.cjs");
main(() => scenario("bug-bytes", async (f) => {
  const repo = f.repository("projects/repo"), w = repo.worktree("target");
  // Python passes raw byte argv to Git; Node's argv strings cannot represent it.
  const py = "import os,subprocess,sys\np=os.fsencode(sys.argv[1])+b'/bad-\\xff'\nsubprocess.run([b'git',b'-C',os.fsencode(sys.argv[2]),b'worktree',b'move',os.fsencode(sys.argv[3]),p],check=True)\n";
  const r = f.run("python3", ["-c", py, f.root, repo.path, w.path]); assert.equal(r.status, 0, r.stderr);
  const report = json(f.cli("list", "--path", f.root, "--json"));
  console.log(report.worktrees.map((x) => ({ path: x.path, recommended: x.recommended })));
  assert.equal(report.worktrees.length, 1);
  assert.ok(fs.existsSync(report.worktrees[0].path), "JSON path cannot identify the actual worktree bytes");
}));
