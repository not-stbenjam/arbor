"use strict";

// A selection can be gathered over several searches, and whatever is then
// deleted is first shown in full: every worktree, in the list or not, with
// what deleting it means.

const { scenario, assert } = require("./harness.cjs");
const { record, gone, search, shown } = require("./list-helpers.cjs");

scenario({
  name: "a selection gathered across searches is reviewed in full",
  timeout: 40,
  setup(fixture) {
    const repository = fixture.repository("projects/repo");
    const trees = {
      a1: repository.worktree("agent-a1"),
      a2: repository.worktree("agent-a2"),
      b1: repository.worktree("spike-b1", { commits: 1 }),
      b2: repository.worktree("spike-b2", { modified: true }),
      c1: repository.worktree("keep-c1"),
      c2: repository.worktree("keep-c2", { untracked: true }),
    };
    fixture.preferences();
    return Object.fromEntries(Object.entries(trees).map(([name, tree]) => [name, record(tree)]));
  },
  launches: [
    async (t) => {
      const { a1, a2, b1, b2, c1, c2 } = t.world;
      const reviewOpen = () => t.js("document.querySelector('#cleanup-dialog').open");
      await t.settled();
      await t.step("ticks made under one search are still there under the next", async () => {
        await search(t, "agent");
        await shown(t, ["agent-a1", "agent-a2"]);
        await t.click("#select-all");
        assert.equal(await t.text("#selection-label"), "2 worktrees selected");
        await search(t, "spike");
        assert.equal(await t.text("#selection-label"), "2 worktrees selected · 2 not shown");
        await t.click("#select-all");
        assert.equal(await t.text("#selection-label"), "4 worktrees selected · 2 not shown · 1 would lose files");
        await search(t, "keep");
        assert.equal(await t.text("#selection-label"), "4 worktrees selected · 4 not shown · 1 would lose files");
        assert.equal(await t.count(".worktree-row.selected"), 0);
      });
      await t.step("deleting them shows all four, though the list shows none of them", async () => {
        await t.click("#remove-selected");
        await t.until(reviewOpen, "the review");
        assert.equal(await t.text("#cleanup-title"), "Delete these 4 worktrees?");
        assert.deepEqual(await t.texts(".cleanup-name"), ["agent-a1", "agent-a2", "spike-b1", "spike-b2"]);
        assert.deepEqual(await t.texts(".cleanup-path"), [a1, a2, b1, b2].map((tree) => tree.path));
        assert.deepEqual(await t.texts(".cleanup-reason"), [
          "All commits are in origin/main",
          "All commits are in origin/main",
          "Not merged; branch kept",
          "Uncommitted changes · Show files",
        ]);
        assert.match(await t.text("#cleanup-total"), /4 not shown in the list/);
        assert.deepEqual(t.messages, []);
        // Cancelling leaves the selection, and everything on disk, as it was.
        await t.press("Escape");
        assert.equal(await reviewOpen(), false);
        assert.equal(await t.text("#selection-label"), "4 worktrees selected · 4 not shown · 1 would lose files");
        for (const tree of Object.values(t.world)) assert.equal(t.fixture.exists(tree.path), true);
      });
      await t.step("agreeing deletes exactly those, asking once more about the one with changes", async () => {
        await t.click("#remove-selected");
        await t.until(reviewOpen, "the review");
        t.answer("Delete");
        await t.click("#cleanup-confirm");
        for (const tree of [a1, a2, b1, b2]) await gone(t, tree);
        assert.equal(t.messages.length, 1);
        assert.match(t.messages[0].message, /Delete 4 worktrees\?/);
        for (const tree of [c1, c2]) assert.equal(t.fixture.exists(tree.path), true);
        assert.equal(t.fixture.read(`${c2.path}/notes.txt`), "not added\n");
        assert.match(await t.text("#toast-region"), /Deleted 4 worktrees/);
        assert.equal(await t.visible("#selection-bar"), false);
      });
      await t.step("Down from the search goes to its first result, with the keyboard", async () => {
        await search(t, "keep");
        await shown(t, ["keep-c1", "keep-c2"]);
        assert.match(await t.focused(), /search/);
        await t.press("Down");
        assert.equal(await t.focused(), "table#worktree-grid.directory-table");
        assert.equal((await t.rows()).find((row) => row.current).id, (await t.worktree(c1.path)).id);
        await t.press("Down");
        assert.equal((await t.rows()).find((row) => row.current).id, (await t.worktree(c2.path)).id);
        assert.equal(await t.visible("#selection-bar"), false, "moving ticks nothing");
      });
      await t.step("one ticked worktree that is out of view is shown too, not asked about by name alone", async () => {
        await search(t, "");
        await shown(t, ["keep-c1", "keep-c2"]);
        await t.click(`${await t.row(c2.path)} .branch-cell`);
        await search(t, "keep-c1");
        assert.equal(await t.text("#selection-label"), "1 worktree selected · 1 not shown · 1 would lose files");
        // Delete on the row in view still means what is ticked.
        await t.click(`${await t.row(c1.path)} .activity-cell`, { button: "right" });
        await t.press("Delete");
        await t.until(reviewOpen, "the review");
        assert.deepEqual(await t.texts(".cleanup-name"), ["keep-c2"]);
        assert.equal(await t.text("#cleanup-title"), "Delete this worktree?");
        assert.equal(t.messages.length, 1, "no question by name alone for a row that cannot be seen");
        await t.click("#cleanup-cancel");
        assert.equal(t.fixture.exists(c2.path), true);
      });
    },
  ],
});
