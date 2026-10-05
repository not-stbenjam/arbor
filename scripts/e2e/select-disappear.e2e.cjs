"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone, selected, leaves } = require("./list-helpers.cjs");

scenario({
  name: "selection follows deleted rows",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = ["a", "b", "c"].map((name) => record(repo.worktree(name)));
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("Delete key uses ticks, then the cursor; disappearing rows do not leave a hidden selection", async () => {
      await t.click(`${await t.row(t.world[1].path)} .branch-cell`);
      t.answer(1); await t.press("Delete"); await gone(t, t.world[1]);
      await selected(t, []);
      assert.match(await t.focused(), /table#worktree-grid/);
      assert.equal((await leaves(t)).find((row) => row.current).id, (await t.worktree(t.world[2].path)).id);
      t.answer(1); await t.press("Delete"); await gone(t, t.world[2]);
      assert.equal((await leaves(t)).find((row) => row.current).id, (await t.worktree(t.world[0].path)).id);
      assert.equal(t.fixture.exists(t.world[0].path), true);
      assert.equal(t.fixture.statistics().removedWorktrees, 2);
      // Losing focus after the last row goes is a separate failing scenario:
      // bugs/last-delete-focus.e2e.cjs.
    });
  }],
});
