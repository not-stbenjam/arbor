"use strict";

// Each of these once went wrong. They are kept as what must stay right.

const { main, scenario, assert, fs, quote, json, list } = require("./helpers.cjs");

main(async () => {
  await scenario("safety-safe-ignored", async (f) => {
    const repo = f.repository("projects/repo", {ignore:["node_modules/", ".env"]});
    const covered = repo.worktree("covered", {ignored: {"node_modules/cache": "generated"}});
    const mixed = repo.worktree("mixed", {ignored: {"node_modules/cache": "generated", ".env": "secret"}});
    const nested = repo.worktree("nested", {ignored: {"node_modules/cache": "generated"}});
    f.repository("projects/nested/node_modules/clone", {remote: false});
    const rows = list(f).worktrees;
    assert.equal(rows.find(w => w.path === covered.path).recommended, true);
    assert.equal(rows.find(w => w.path === mixed.path).recommended, false);
    assert.ok(rows.find(w => w.path === nested.path).losses.includes("nested"));
    const clean = f.cli("clean", "--path", f.root, "--yes", "--json");
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(f.exists(covered.path), false);
    assert.ok(f.exists(mixed.path)); assert.ok(f.exists(nested.path));
    const later = repo.worktree("later", {ignored: {"node_modules/cache": "generated"}});
    list(f);
    f.write("projects/later/.env", "new secret");
    f.git(repo.path, "config", "core.excludesFile", f.write("exclude", ".env\n"));
    assert.notEqual(f.cli("remove", later.path, "--yes").status, 0);
    assert.ok(f.exists(later.path));
  });

  // One worktree named to be removed is the folder at that path, not
  // whatever a symbolic link put there leads to.
  await scenario("safety-symlink", async (f) => {
    const repo = f.repository("projects/repo");
    const target = repo.worktree("target"), sibling = repo.worktree("sibling");
    const marker = f.write("projects/sibling/kept.log", "must survive");
    list(f);
    fs.renameSync(target.path, target.path + "-saved");
    fs.symlinkSync(sibling.path, target.path);
    const result = f.cli("remove", target.path, "--force", "--yes", "--json");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is a symbolic link to .*sibling; name the worktree itself/);
    assert.ok(f.exists(marker), "removal followed the replacement symlink into a sibling");
    assert.match(repo.git("worktree", "list"), /sibling/);
  });

  // A pattern Match would reject is refused before anything is scanned.
  await scenario("safety-exclude", async (f) => {
    f.repository("projects/repo").worktree("kept");
    for (const pattern of ["0*\\", "a[", "[]", "x\\"]) {
      const result = f.cli("list", "--path", f.root, "--exclude", pattern, "--json");
      assert.notEqual(result.status, 0, pattern);
      assert.ok(!result.stderr.includes("panic:") && !result.stderr.includes("goroutine"), result.stderr);
      assert.equal(result.stdout, "");
    }
  });

  // --head given and left empty would require no commit at all.
  await scenario("safety-head", async (f) => {
    const tree = f.repository("projects/repo").worktree("target");
    const result = f.cli("remove", tree.path, "--head=", "--yes", "--json");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--head needs the commit to require/);
    assert.ok(f.exists(tree.path));
  });

  // Arbor takes away an empty folder itself, before Git removes its record.
  // If Git then refuses, the folder is put back: a refusal changes nothing.
  await scenario("safety-empty", async (f) => {
    const repo = f.repository("projects/repo"), tree = repo.worktree("empty");
    fs.renameSync(tree.path, tree.path + "-saved");
    fs.mkdirSync(tree.path);
    const git = f.run("sh", ["-c", "command -v git"]).stdout.trim();
    f.tool("git", `case "$*" in *'worktree remove'*) echo 'Git would not' >&2; exit 1;; esac\nexec ${quote(git)} "$@"`);
    const result = f.cli("remove", tree.path, "--repo", repo.path, "--force", "--yes", "--json");
    assert.notEqual(result.status, 0);
    assert.ok(fs.statSync(tree.path).isDirectory(), "the empty folder was not put back");
    assert.deepEqual(fs.readdirSync(tree.path), []);
  });

  // A path that is not text cannot be named to Git reliably, so nothing is
  // offered for it and nothing beside it is mistaken for it.
  await scenario("safety-bytes", async (f) => {
    const repo = f.repository("projects/repo"), tree = repo.worktree("target");
    const move = "import os,subprocess,sys\np=os.fsencode(sys.argv[1])+b'/bad-\\xff'\nsubprocess.run([b'git',b'-C',os.fsencode(sys.argv[2]),b'worktree',b'move',os.fsencode(sys.argv[3]),p],check=True)\n";
    const moved = f.run("python3", ["-c", move, f.root, repo.path, tree.path]);
    if (moved.status !== 0) return console.log("skipped: this filesystem takes only names that are text");
    const report = list(f);
    assert.equal(report.worktrees.length, 1);
    const [row] = report.worktrees;
    assert.deepEqual([row.recommended, row.canRemove, row.canDiscard], [false, false, false]);
    assert.match(row.blockers.join(" "), /Path is not valid text/);
    assert.deepEqual(json(f.cli("clean", "--path", f.root, "--all", "--force", "--yes", "--json")), []);
    assert.match(repo.git("worktree", "list"), /bad-/);
  });

  // Refs under refs/worktree are deleted with their worktree, and a commit
  // only they point to has nothing else to keep it.
  await scenario("safety-refs", async (f) => {
    const repo = f.repository("projects/repo"), tree = repo.worktree("target", { commits: 1 });
    const kept = f.git(tree.path, "rev-parse", "HEAD");
    f.git(tree.path, "update-ref", "refs/worktree/kept", kept);
    f.git(tree.path, "reset", "-q", "--hard", "main");
    const [row] = list(f).worktrees;
    assert.deepEqual([row.recommended, row.canRemove, row.canDiscard], [false, false, true]);
    assert.deepEqual(json(f.cli("clean", "--path", f.root, "--yes", "--json")), []);
    const refused = f.cli("remove", tree.path, "--yes", "--json");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refs of its own/);
    assert.equal(f.git(tree.path, "rev-parse", "refs/worktree/kept"), kept);
    assert.equal(json(f.cli("remove", tree.path, "--force", "--yes", "--json")).removed, true);
  });
});
