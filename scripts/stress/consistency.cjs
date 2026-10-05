"use strict";
const { main, scenario, assert, fs, path, ok, json, entry } = require("./helpers.cjs");
const mutations = {
  tracked(f, r, w) { fs.appendFileSync(path.join(w.path, "README.md"), "changed\n"); },
  untracked(f, r, w) { f.write(path.join(w.path, "notes"), "precious"); },
  ignored(f, r, w) { f.write(path.join(w.path, "local.log"), "precious"); },
  commit(f, r, w) { r.commit("new work", { where: w.path }); },
  branch(f, r, w) { f.git(w.path, "switch", "-c", "different"); },
  locked(f, r, w) { r.git("worktree", "lock", w.path); },
  repository(f, r, w) { fs.renameSync(w.path, w.path + "-saved"); f.repository(path.relative(f.directory, w.path)); },
  symlink(f, r, w) { fs.renameSync(w.path, w.path + "-saved"); fs.symlinkSync(f.path("outside"), w.path); },
  file(f, r, w) { fs.renameSync(w.path, w.path + "-saved"); fs.writeFileSync(w.path, "replacement"); },
  missing(f, r, w) { fs.renameSync(w.path, w.path + "-saved"); },
  default(f, r, w) { r.git("update-ref", "refs/remotes/origin/main", r.head("HEAD~1")); },
};
main(async () => {
  for (const [name, mutate] of Object.entries(mutations)) await scenario(`consistency-${name}`, async (f) => {
    const repo = f.repository("projects/repo");
    repo.commit("advanced"); repo.git("push", "-q", "origin", "main");
    const w = repo.worktree("target"), sibling = repo.worktree("sibling");
    const marker = f.write("outside/marker", "untouched");
    const primary = fs.readFileSync(path.join(repo.path, "README.md"));
    const snapshot = entry(f, w); assert.ok(snapshot.recommended);
    json(f.cli("remove", w.path, "--json"));
    mutate(f, repo, w);
    const result = f.cli("remove", w.path, "--yes", "--json", "--repo", repo.path,
      "--head", snapshot.head, "--id", snapshot.id, "--branch", snapshot.branch, "--recommended-only");
    assert.notEqual(result.status, 0, `${name}: ${JSON.stringify(result)}`);
    assert.ok(result.stderr.trim(), `${name}: refusal must explain`);
    assert.equal(fs.readFileSync(marker, "utf8"), "untouched");
    assert.deepEqual(fs.readFileSync(path.join(repo.path, "README.md")), primary);
    assert.ok(f.exists(sibling.path)); assert.ok(f.exists(path.join(repo.path, ".git", "HEAD")));
    if (!["missing"].includes(name)) assert.ok(fs.lstatSync(w.path));
    if (["tracked", "untracked", "ignored", "locked", "default"].includes(name)) {
      ok(f.cli("clean", "--path", w.path, "--yes", "--json")); assert.ok(f.exists(w.path));
    }
  });
  await scenario("scope", async (f) => {
    const repo = f.repository("projects/repo"), inside = repo.worktree("inside"), outside = repo.worktree("outside", { at: "elsewhere/outside" });
    f.write("projects/marker", "stay");
    for (const target of [repo.path, path.join(repo.path, ".git"), f.root]) assert.notEqual(f.cli("remove", target, "--force", "--yes").status, 0);
    ok(f.cli("clean", "--path", inside.path, "--all", "--force", "--yes"));
    assert.ok(f.exists(outside.path)); assert.equal(f.read("projects/marker"), "stay");
  });
});
