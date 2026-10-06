"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "literal hostile names and exact deletion", timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const names = ['space name', 'single\'double"', 'back\\slash', '$(touch PWNED)', 'semi;touch PWNED', '-leading', '<img src=x onerror=alert(1)>', '🌳-emoji', 'עברית', 'safe\u202eevil', 'café', 'cafe\u0301', 'Case', 'case', 'line\nbreak', 'x'.repeat(255)];
    const trees = names.map((name, i) => repo.worktree(`branch-${i}`, { at: path.join("projects", name) }));
    trees.push(repo.worktree("deep", { at: path.join("projects", ...Array.from({length: 18}, (_, i) => `depth-${i}`), "leaf") }));
    const branches = ['quote\'"', '$(literal)', 'semi;colon', 'emoji-🌳', 'rtl-עברית', 'combining-e\u0301'];
    branches.forEach((branch, i) => trees.push(repo.worktree(`branch-path-${i}`, { branch })));
    const keep = f.repository("outside/untouched", {remote:false});
    f.write("outside/sentinel", "outside survives\n");
    fs.symlinkSync(keep.path, f.path("projects/repository-link"));
    fs.symlinkSync(trees[0].path, f.path("projects/worktree-link"));
    fs.symlinkSync(f.path("outside"), path.join(trees[0].path, "outside-link"));
    // The link is local untracked data, so it needs explicit discard consent.
    f.preferences();
    return { paths: trees.map(t => t.path), repo: repo.path, head: repo.head(), keep: keep.path };
  },
  launches: [async t => {
    await t.settled();
    const rows = (await t.state()).report.worktrees;
    assert.deepEqual(rows.map(r=>r.path).sort(), [...t.world.paths].sort());
    assert.equal(new Set(rows.map(r=>r.id)).size, rows.length);
    for (const p of t.world.paths) {
      const row = await t.row(p);
      assert.equal(await t.attribute(row, "data-path"), p);
      // What is shown marks characters that hide or reorder a name; the
      // row's own record of the path, above, keeps every one of them.
      assert.equal(await t.attribute(`${row} .worktree-path`, "title"), p.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "\ufffd"));
    }
    assert.equal(await t.count("#worktree-list img, #worktree-list script"), 0);
    assert.equal(t.fixture.exists("PWNED"), false);
    assert.equal(t.fixture.exists("projects/PWNED"), false);
    await t.step("review preserves literal text and cancel changes no folders", async () => {
      await t.click("#cleanup-button");
      await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "review");
      assert.equal(await t.count("#cleanup-list img, #cleanup-list script"), 0);
      assert.match(await t.text("#cleanup-list"), /<img src=x onerror=alert\(1\)>/);
      assert.equal(await t.js("/[\\u202a-\\u202e]/.test(document.querySelector('#cleanup-list').textContent)"), false);
      await t.press("Escape");
      for (const p of t.world.paths) assert.ok(t.fixture.exists(p));
    });
    await t.step("deleting the shell-like name affects exactly that checkout", async () => {
      const target = t.world.paths.find(p => p.endsWith('$(touch PWNED)'));
      t.answer("Delete Worktree"); await t.click(`${await t.row(target)} [data-delete]`);
      await t.until(() => !t.fixture.exists(target), "literal target removed"); await t.settled();
      for (const p of t.world.paths.filter(p=>p!==target)) assert.ok(t.fixture.exists(p), p);
    });
    await t.step("discarding a checkout containing a symlink never follows its target", async () => {
      await t.click('.toast button[aria-label="Dismiss notification"]');
      t.answer(box => { assert.equal(box.buttons[1], "Discard & Delete"); return 1; }); await t.click(`${await t.row(t.world.paths[0])} [data-delete]`);
      await t.until(() => !t.fixture.exists(t.world.paths[0]), "linked checkout removed"); await t.settled();
      assert.equal(t.fixture.read("outside/sentinel"), "outside survives\n");
      assert.ok(t.fixture.exists(t.world.keep));
      assert.equal(t.fixture.git(t.world.repo,"rev-parse","HEAD"), t.world.head);
      assert.ok(t.fixture.git(t.world.repo,"rev-parse","refs/heads/branch-0"));
      assert.equal(fs.lstatSync(t.fixture.path("projects/worktree-link")).isSymbolicLink(), true);
    });
    await t.step("remaining hostile names delete literally and retain every branch", async () => {
      await t.click('.toast button[aria-label="Dismiss notification"]');
      const upper=t.world.paths.find(p=>p.endsWith("/Case"));
      const lower=t.world.paths.find(p=>p.endsWith("/case"));
      t.answer("Delete Worktree"); await t.click(`${await t.row(upper)} [data-delete]`);
      await t.until(()=>!t.fixture.exists(upper),"uppercase checkout removed"); await t.settled();
      assert.ok(t.fixture.exists(lower),"case-sensitive neighbour is kept");
      await t.click('.toast button[aria-label="Dismiss notification"]');
      await t.click("#cleanup-button"); await t.until(()=>t.js("document.querySelector('#cleanup-dialog').open"),"remaining review");
      await t.click("#cleanup-confirm");
      await t.until(()=>t.world.paths.every(p=>!t.fixture.exists(p)),"all literal folders removed"); await t.settled();
      assert.equal(t.fixture.git(t.world.repo,"rev-parse","HEAD"),t.world.head);
      assert.equal(t.fixture.read("outside/sentinel"),"outside survives\n");
      assert.equal(t.fixture.git(t.world.repo,"for-each-ref","--format=%(refname)","refs/heads").split("\n").length,t.world.paths.length+1);
    });
  }],
});
