"use strict";
// Run after build-desktop.cjs --prepare, with TMPDIR set to your own temp folder.
const fs = require("node:fs");
const path = require("node:path");
const { createDirectory, createFixture } = require("../e2e/fixture.cjs");
function workspace() {
  const f = createFixture(createDirectory("ux-cli"));
  const repos = [], trees = [];
  const variants = [
    {}, { commits: 1, merged: true }, { commits: 1, merged: "squash" },
    { hoursOld: 0 }, { modified: true }, { untracked: true },
    { ignored: { "node_modules/cache": 1048576 } }, { locked: "Active deployment" },
    { detached: true, commits: 1 }, { missing: true }, { commits: 2 },
    { commits: 1, pushed: true },
  ];
  for (let i = 0; i < 12; i++) {
    const r = f.repository(`projects/team-${i}/service-${i}`, { hoursOld: 1500 });
    repos.push(r);
    for (let j = 0; j < 5; j++) {
      const n = i * 5 + j;
      trees.push(r.worktree(`task-${String(n).padStart(2, "0")}`, {
        ...variants[n % variants.length], hoursOld: n % 12 === 3 ? 0 : 1000,
        branch: n === 0 ? "feature/a-very-long-description-of-the-task-with-a-unique-ending" : `task-${n}`,
      }));
    }
  }
  const extra = (name, opts = {}) => { const w = repos[0].worktree(name, opts); trees.push(w); return w; };
  const empty = extra("empty"); fs.rmSync(empty.path, { recursive: true }); fs.mkdirSync(empty.path);
  const unchecked = extra("unchecked"); f.git(unchecked.path, "update-index", "--assume-unchanged", "README.md");
  fs.appendFileSync(path.join(unchecked.path, "README.md"), "unseen\n");
  const operation = extra("operation");
  f.write(f.git(operation.path, "rev-parse", "--git-path", "MERGE_HEAD"), repos[0].head() + "\n");
  const nested = extra("nested"); f.repository(path.relative(f.directory, path.join(nested.path, "inner")));
  const sub = extra("submodule"); f.git(sub.path, "submodule", "add", "-q", repos[1].path, "library");
  f.git(sub.path, "commit", "-qm", "Add library");
  const missingSub = extra("missing-submodule");
  f.git(missingSub.path, "submodule", "add", "-q", repos[1].path, "library");
  f.git(missingSub.path, "commit", "-qm", "Add library");
  fs.rmSync(missingSub.path, { recursive: true });
  extra("protected", { branch: "develop" });
  extra("space and\nnewline", { branch: "unusual-path" });
  const broken = extra("broken"); fs.writeFileSync(path.join(broken.path, ".git"), "gitdir: /not-a-repository\n");
  // Checkout metadata mtimes also count as activity; creation dates alone do not.
  for (const [i, tree] of trees.entries()) {
    if (fs.existsSync(tree.path) && tree !== broken && tree !== empty) {
      const hours = i % 12 === 3 ? 0 : [1000, 72, 2][i % 3];
      if (hours) {
        f.backdate(tree.path, hours);
        f.backdate(f.git(tree.path, "rev-parse", "--absolute-git-dir"), hours);
      }
    }
  }
  const host = f.host("review-host");
  const remote = f.repository(host.relative("projects", "remote-service"));
  remote.worktree("remote-merged"); remote.worktree("remote-dirty", { modified: true });
  f.write("home/.ssh/config", "Host review-host\n  HostName review.invalid\n");
  return { f, repos, trees, host };
}
module.exports = { workspace };
if (require.main === module) console.log(workspace().f.directory);
