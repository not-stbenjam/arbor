"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "real repository operations and protection", timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo", { remote: false, files: { "conflict.txt": "base\n", "included/file": "keep", "omitted/file": "skip" } });
    const base = repo.head();
    repo.commit("upstream change", { files: {"conflict.txt":"upstream\n"} });
    const operations = {};
    for (const operation of ["merge","rebase","cherry-pick"]) {
      const tree = repo.worktree(operation, { from: base });
      repo.commit("topic change", { where: tree.path, files: {"conflict.txt":"topic\n"} });
      const args = operation === "merge" ? ["merge", "main"] : operation === "rebase" ? ["rebase", "main"] : ["cherry-pick", repo.head()];
      const result = f.run("git", ["-C",tree.path,...args]);
      assert.equal(result.status,1, `real ${operation} stops at a conflict: ${result.stderr}`);
      operations[operation] = tree.path;
    }
    const bisect = repo.worktree("bisect");
    f.git(bisect.path, "bisect", "start", "HEAD", base);
    operations.bisect = bisect.path;
    const nested = repo.worktree("nested");
    f.repository(path.join(nested.path,"child"),{remote:false});
    const sub = f.repository("outside/sub", {remote:false});
    const modules = repo.worktree("modules");
    f.git(modules.path,"submodule","add","-q",sub.path,"module");
    repo.commit("Submodule",{where:modules.path, files:{"marker":"module"}});
    const sparse = repo.worktree("sparse");
    // fixture.worktree backdates files; refresh Git's stat cache before
    // sparse-checkout, or Git keeps apparently changed omitted files.
    f.git(sparse.path,"update-index","--refresh");
    f.git(sparse.path,"sparse-checkout","set","--cone","included");
    assert.equal(f.exists(path.join(sparse.path,"omitted/file")),false);
    const broken = repo.worktree("broken");
    f.write(path.join(broken.path,".git"),`gitdir: ${f.path("missing-metadata")}\n`);
    const unreadable = repo.worktree("unreadable");
    const readonly = repo.worktree("readonly");
    fs.chmodSync(unreadable.path,0);
    fs.chmodSync(readonly.path,0o555);
    // Thousands of refs share the same object, avoiding thousands of files.
    const refs = Array.from({length:2000},(_,i)=>`create refs/heads/extra-${i} ${repo.head()}\n`).join('');
    const updated=f.run('git',['-C',repo.path,'update-ref','--stdin'],{input:refs}); assert.equal(updated.status,0);
    repo.git("pack-refs","--all");
    f.preferences();
    return { operations, nested:nested.path, modules:modules.path, sparse:sparse.path, broken:broken.path, unreadable:unreadable.path, readonly:readonly.path, repo:repo.path, head:repo.head() };
  },
  launches: [async t => {
    try {
      await t.settled();
      await t.step("unfinished Git operations are named and never recommended",async()=>{
        for (const [name,p] of Object.entries(t.world.operations)) {
          const w=await t.worktree(p); assert.ok(w, name); assert.equal(w.recommended,false,name); assert.ok(w.losses.includes('operation'),name);
          assert.match(await t.text(await t.row(p)), /Git operation|changed file/);
          t.answer("Cancel"); await t.click(`${await t.row(p)} [data-delete]`);
          await t.until(()=>t.messages.length>0 && t.messages.at(-1).detail.includes('unfinished rebase, merge or cherry-pick'),name);
          await t.settled(); assert.ok(t.fixture.exists(p));
        }
      });
      await t.step("submodules and nested repositories require specific consent",async()=>{
        for (const [p,loss] of [[t.world.modules,'submodules'],[t.world.nested,'nested']]) {
          const w=await t.worktree(p); assert.equal(w.recommended,false); assert.ok(w.losses.includes(loss));
          t.answer("Cancel"); await t.click(`${await t.row(p)} [data-delete]`); await t.settled();
          assert.equal(t.messages.at(-1).title,'Delete worktrees?');
          assert.match(t.messages.at(-1).detail, loss==='nested' ? /nested repository/ : /submodules and their unpushed commits/);
          assert.ok(t.fixture.exists(p));
        }
      });
      await t.step("corrupt and unreadable checkouts cannot be deleted; sparse checkout is clean",async()=>{
        for (const p of [t.world.broken,t.world.unreadable]) {
          const w=await t.worktree(p); assert.ok(w); assert.equal(w.canRemove,false); assert.equal(w.canDiscard,false); assert.equal(w.recommended,false);
          // Its Delete is off and says why, with nothing to press and nothing asked.
          const before = t.messages.length;
          assert.equal(await t.enabled(`${await t.row(p)} [data-delete]`), false);
          assert.match(await t.attribute(`${await t.row(p)} [data-delete]`, "title"), /^Cannot be deleted: /);
          assert.equal(t.messages.length, before); assert.ok(t.fixture.exists(p));
        }
        const sparse=await t.worktree(t.world.sparse); assert.equal(sparse.recommended,true); assert.deepEqual(sparse.losses,[]);
        assert.equal(t.fixture.exists(path.join(t.world.sparse,'omitted/file')),false);
        assert.equal(t.fixture.git(t.world.repo,'rev-parse','HEAD'),t.world.head);
        assert.ok(t.fixture.exists(t.world.readonly));
      });
      await t.click("#warning-button");
      await t.until(()=>t.js("document.querySelector('#notes-dialog').open"),'warnings dialog');
      assert.match(await t.text('#notes-content'),/unreadable|broken|Cannot read/);
      await t.press("Escape");
    } finally {
      fs.chmodSync(t.world.unreadable,0o755);
      fs.chmodSync(t.world.readonly,0o755);
    }
  }],
});
