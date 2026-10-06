"use strict";
const fs = require("node:fs");
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "failed read-only deletion stays visible for retry", timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const tree = repo.worktree("readonly");
    fs.chmodSync(tree.path, 0o555);
    f.preferences();
    return { path: tree.path };
  },
  launches: [async t => {
    try {
      await t.settled(); await t.painted();
      t.answer("Delete Worktree");
      await t.click(`${await t.row(t.world.path)} [data-delete]`);
      await t.until(() => t.visible("#error-banner"), "permission error");
      await t.settled(); await t.painted();
      assert.ok(t.fixture.exists(t.world.path), "the folder still exists");
      assert.ok(await t.worktree(t.world.path), "a failed deletion must stay in the list for repair/retry");
      // It says what is in the way and how to clear it, and Git still knows
      // the worktree, with every file where it was.
      assert.match(await t.text("#error-message"), /it is read-only.*Make it writable \(chmod -R u\+w on the worktree\) and delete again/s);
      assert.match(t.fixture.git("projects/repo", "worktree", "list"), /readonly/);
      assert.equal(t.fixture.exists(`${t.world.path}/README.md`), true);
      // Made writable, the same row deletes.
      fs.chmodSync(t.world.path, 0o755);
      await t.click("#dismiss-error");
      t.answer("Delete Worktree");
      await t.click(`${await t.row(t.world.path)} [data-delete]`);
      await t.until(() => !t.fixture.exists(t.world.path), "the folder goes once it is writable");
      await t.settled();
    } finally {
      if (fs.existsSync(t.world.path)) fs.chmodSync(t.world.path, 0o755);
    }
  }],
});
