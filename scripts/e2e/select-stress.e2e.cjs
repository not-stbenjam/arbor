"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, search } = require("./list-helpers.cjs");

scenario({
  name: "selection stress in nested folders",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = Array.from({ length: 48 }, (_, i) => record(repo.worktree(`work-${String(i).padStart(2, "0")}`, { at: `projects/group-${Math.floor(i / 8)}/work-${String(i).padStart(2, "0")}` })));
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("48 real worktrees survive repeated selection, collapse, sort and search", async () => {
      assert.equal(await t.text("#all-count"), "48");
      for (let i = 0; i < 6; i++) {
        await t.click("#select-all");
        assert.equal(await t.text("#selection-label"), "48 worktrees selected");
        await t.click("#sort-direction");
        assert.equal(await t.count(".worktree-row.selected"), 48);
        const folder = `tr[data-directory-path=${JSON.stringify(t.fixture.path(`projects/group-${i}`))}] [data-toggle-directory]`;
        // A closed folder and a search each take rows out of the list
        // without taking them out of the selection.
        await t.click(folder);
        assert.equal(await t.count(".worktree-row.selected"), 40);
        assert.equal(await t.text("#selection-label"), "48 worktrees selected · 8 not shown");
        await t.click(folder);
        assert.equal(await t.count(".worktree-row"), 48);
        assert.equal(await t.count(".worktree-row.selected"), 48, "its ticks are there when the folder opens again");
        await search(t, `group-${i}`);
        assert.equal(await t.count(".worktree-row"), 8);
        assert.equal(await t.text("#selection-label"), "48 worktrees selected · 40 not shown");
        // The heading's box unticks what is shown, and only that.
        await t.click("#select-all");
        assert.equal(await t.text("#selection-label"), "40 worktrees selected · 40 not shown");
        await t.click("#select-all");
        assert.equal(await t.text("#selection-label"), "48 worktrees selected · 40 not shown");
        await search(t, "");
        assert.equal(await t.text("#selection-label"), "48 worktrees selected");
        await t.click("#clear-selection");
      }
      await t.click("#cleanup-button");
      assert.equal(await t.count(".cleanup-item"), 48);
      assert.equal(await t.text("#cleanup-confirm"), "Delete 48 worktrees");
      await t.press("Escape");
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
      assert.equal(t.fixture.git(t.world[0].repository, "worktree", "list").split("\n").length, 49);
      assert.equal(t.fixture.statistics(), null);
    });
  }],
});
