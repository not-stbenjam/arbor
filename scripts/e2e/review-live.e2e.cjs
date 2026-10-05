"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone } = require("./list-helpers.cjs");

scenario({
  name: "review keeps changed rows after refresh",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = [repo.worktree("a-changed"), repo.worktree("b-safe"), repo.worktree("c-later", { modified: true })].map(record);
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("refresh marks changed rows Kept and never adds new recommendations to consent", async () => {
      await t.click("#cleanup-button");
      t.fixture.write(`${t.world[0].path}/late.txt`, "keep this");
      t.fixture.git(t.world[2].path, "restore", "README.md");
      await t.menu("File", "Refresh Worktrees");
      await t.until(async () => /Changed since/.test(await t.text(".cleanup-item.changed") || ""), "review marks the changed row");
      assert.deepEqual(await t.texts(".cleanup-name"), ["a-changed", "b-safe"]);
      assert.match(await t.text(".cleanup-item.changed"), /Kept/);
      assert.equal(await t.text("#cleanup-confirm"), "Delete 1 worktree");
      await t.settled();
      await t.click("#cleanup-confirm");
      await gone(t, t.world[1]);
      assert.equal(t.fixture.read(`${t.world[0].path}/late.txt`), "keep this");
      assert.equal(t.fixture.exists(t.world[2].path), true);
      assert.equal(t.fixture.statistics().removedWorktrees, 1);
    });
  }],
});
