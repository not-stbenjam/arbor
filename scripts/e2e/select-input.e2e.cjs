"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, selected, leaves, shown } = require("./list-helpers.cjs");

scenario({
  name: "selection input",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = ["a", "b", "c", "d"].map((name) => record(repo.worktree(name)));
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await shown(t, ["a", "b", "c", "d"]);
    const rows = await Promise.all(t.world.map((tree) => t.row(tree.path)));
    const click = (index, options) => t.click(`${rows[index]} .branch-cell`, options);
    await t.step("click toggles one row and Shift-click adds a range", async () => {
      await click(0); await selected(t, ["a"]);
      assert.equal(await t.text("#selection-label"), "1 worktree selected");
      await click(2); await selected(t, ["a", "c"]);
      await click(0); await selected(t, ["c"]);
      await click(3, { shift: true }); await selected(t, ["a", "b", "c", "d"]);
      await t.click("#clear-selection"); await selected(t, []);
      assert.match(await t.focused(), /table#worktree-grid/);
      await t.click(`${rows[1]} [data-select]`); await selected(t, ["b"]);
      await t.click(`${rows[1]} [data-select]`); await selected(t, []);
    });
    await t.step("drag does not tick; right-click only moves the cursor", async () => {
      const point = await t.point(`${rows[0]} .branch-cell`);
      await t.drag(point, { x: point.x + 70, y: point.y });
      await selected(t, []);
      await click(0);
      await t.contextMenu(`${rows[2]} .branch-cell`);
      await selected(t, ["a"]);
      assert.equal((await leaves(t)).find((row) => row.current).id, (await t.worktree(t.world[2].path)).id);
      await t.press("Space"); await selected(t, ["a", "c"]);
      await t.press("Up"); await selected(t, ["a", "c"]);
      await t.press("Shift+Down"); await selected(t, ["a", "b", "c"]);
      await t.press("Escape"); await selected(t, []);
    });
    await t.step("folder and heading checkboxes toggle all shown descendants", async () => {
      await t.click("[data-directory-path] [data-select-folder]");
      await selected(t, ["a", "b", "c", "d"]);
      assert.equal(await t.checked("#select-all"), true);
      await t.click("#select-all"); await selected(t, []);
      await t.click("#select-all"); await selected(t, ["a", "b", "c", "d"]);
      // Closing the folder takes the rows out of the list, not out of the
      // selection, and the bar says how many it no longer shows.
      await t.click("[data-directory-path] [data-toggle-directory]");
      assert.equal(await t.count(".worktree-row"), 0);
      assert.equal(await t.text("#selection-label"), "4 worktrees selected · 4 not shown");
      assert.equal(await t.visible("[data-directory-path] [data-select-folder]"), false);
      await t.click("[data-directory-path] [data-toggle-directory]");
      await selected(t, ["a", "b", "c", "d"]);
      await click(0); await selected(t, ["b", "c", "d"]);
      await t.press("Control+a");
      await selected(t, ["a", "b", "c", "d"]);
      await t.press("Escape"); await selected(t, []);
    });
    await t.step("switching sidebar views keeps ticks and a visible cursor", async () => {
      await click(1);
      await t.click('[data-view="recommended"]');
      await selected(t, ["b"]);
      assert.equal((await leaves(t)).find((row) => row.current).id, (await t.worktree(t.world[1].path)).id);
      await t.click("#repo-list .repo-item");
      assert.match(await t.text("#view-title"), /repo/);
      await selected(t, ["b"]);
      await t.click("#repo-list .repo-item");
      assert.equal(await t.text("#view-title"), "All worktrees");
      await selected(t, ["b"]);
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
      assert.equal(t.fixture.statistics(), null);
    });
  }],
});
