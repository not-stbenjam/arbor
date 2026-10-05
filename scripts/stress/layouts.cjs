"use strict";
const { main, scenario, assert, fs, path, ok, json, list } = require("./helpers.cjs");
main(async () => {
  await scenario("names", async (f) => {
    const names = ["space name", "quote'\"", "back\\slash", "dollar$(x)", "semi;colon", "line\nbreak", "-leading", "glob[*]?", "emoji🌳", "עברית", "x".repeat(255)];
    const repo = f.repository("projects/repo ' ; 🌳");
    const trees = names.map((name, i) => repo.worktree(name, { branch: `topic-${i}` }));
    const long = repo.worktree("deep", { at: `projects/${"long/".repeat(100)}tree` }); trees.push(long);
    const seen = list(f).worktrees.map((w) => w.path).sort();
    assert.deepEqual(seen, trees.map((w) => w.path).sort());
    for (const root of ["projects", "projects/../projects", f.root + "/"]) assert.equal(json(f.cli("list", "--path", root, "--json")).worktrees.length, trees.length);
    fs.symlinkSync(f.root, f.path("alias")); fs.symlinkSync(f.root, f.path("projects", "cycle"));
    assert.equal(json(f.cli("list", "--path", f.path("alias"), "--json")).worktrees.length, trees.length);
    fs.symlinkSync(f.root, f.path("home", "projects"));
    assert.equal(json(f.cli("list", "--path", "~/projects", "--json")).worktrees.length, trees.length);
    assert.equal(json(f.cli("list", "--path", repo.path, "--json")).worktrees.length, 0);
    assert.equal(json(f.cli("list", "--path", long.path, "--json")).worktrees.length, 1);
    for (const w of trees) assert.equal(json(f.cli("remove", w.path, "--yes", "--json")).removed, true);
    assert.ok(f.exists(repo.path));
  });
  await scenario("layouts", async (f) => {
    const repo = f.repository("projects/repo");
    const outer = repo.worktree("outer"), nested = repo.worktree("nested", { at: "projects/outer/nested" });
    const detached = repo.worktree("detached", { detached: true, commits: 1 });
    const bare = f.path("projects", "bare.git"); f.git(f.directory, "clone", "--bare", repo.path, bare);
    f.git(bare, "worktree", "add", "-b", "bare-topic", f.path("projects", "bare-tree"));
    f.git(f.directory, "init", f.path("projects", "unborn"));
    f.write("projects/broken/.git", `gitdir: ${f.path("missing-admin")}\n`);
    const report = list(f); assert.ok(report.warnings.some((w) => w.includes("broken")));
    const parent = report.worktrees.find((w) => w.path === outer.path); assert.ok(parent.losses.includes("nested"));
    assert.notEqual(f.cli("remove", outer.path, "--yes").status, 0); assert.ok(f.exists(nested.path));
    const head = f.git(detached.path, "rev-parse", "HEAD");
    const removal = json(f.cli("remove", detached.path, "--force", "--yes", "--json"));
    assert.ok(removal.retainedBranch); assert.equal(repo.head(removal.retainedBranch), head);
    const file = f.write("plain", "data");
    for (const root of [file, f.path("absent")]) assert.notEqual(f.cli("list", "--path", root).status, 0);
    const unreadable = f.path("projects", "unreadable"); fs.mkdirSync(unreadable); fs.chmodSync(unreadable, 0);
    try { if (process.getuid?.() !== 0) assert.notEqual(f.cli("list", "--path", unreadable).status, 0); else console.log("SKIP unreadable: root bypasses permissions"); }
    finally { fs.chmodSync(unreadable, 0o700); }
    fs.chmodSync(outer.path, 0o500);
    try { assert.ok(list(f).worktrees.some((w) => w.path === outer.path)); }
    finally { fs.chmodSync(outer.path, 0o700); }
    console.log("SKIP root scan: no private mount namespace; real / is never scanned");
  });
  await scenario("operations", async (f) => {
    const repo = f.repository("projects/repo", { files: { conflict: "base\n" } });
    const w = repo.worktree("operation", { commits: 1 });
    repo.commit("main", { files: { conflict: "main\n" } });
    repo.commit("topic", { where: w.path, files: { conflict: "topic\n" } });
    for (const operation of ["merge", "rebase"]) {
      const result = f.run("git", ["-C", w.path, operation, "main"]); assert.notEqual(result.status, 0);
      const row = list(f).worktrees.find((x) => x.path === w.path); assert.ok(row.losses.includes("operation"));
      assert.notEqual(f.cli("remove", w.path, "--yes").status, 0); f.git(w.path, operation, "--abort");
    }
    f.git(w.path, "bisect", "start"); f.git(w.path, "bisect", "bad"); f.git(w.path, "bisect", "good", "HEAD~2");
    assert.ok(list(f).worktrees.find((x) => x.path === w.path).losses.includes("operation")); f.git(w.path, "bisect", "reset");
    const module = f.repository("module", { remote: false });
    f.git(w.path, "submodule", "add", module.path, "module"); f.git(w.path, "commit", "-am", "submodule");
    assert.ok(list(f).worktrees.find((x) => x.path === w.path).losses.includes("submodules"));
    assert.notEqual(f.cli("remove", w.path, "--yes").status, 0);
  });
});
