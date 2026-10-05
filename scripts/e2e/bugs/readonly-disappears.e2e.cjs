"use strict";
const fs = require("node:fs");
const { scenario, assert } = require("../harness.cjs");
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
    } finally {
      fs.chmodSync(t.world.path, 0o755);
    }
  }],
});
