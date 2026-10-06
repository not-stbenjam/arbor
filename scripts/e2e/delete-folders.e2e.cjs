"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, search, gone, statistics } = require("./list-helpers.cjs");

scenario({
  name: "delete folder descendants",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = [
      repo.worktree("one", { at: "projects/group/one", modified: true }),
      repo.worktree("two", { at: "projects/group/deep/two" }),
      repo.worktree("three", { at: "projects/group/deep/three" }),
      repo.worktree("outside"),
    ].map(record);
    f.write("projects/group/keep.txt", "not a worktree");
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    const group = `tr[data-directory-path=${JSON.stringify(t.fixture.path("projects/group"))}]`;
    await t.step("folder Delete includes collapsed children and keeps the containing folder", async () => {
      await t.click(`${group} [data-toggle-directory]`);
      // A closed folder shows none of what its Delete takes, so each one is
      // shown before anything is asked.
      await t.click(`${group} [data-folder-delete]`);
      await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "the review of the folder's worktrees");
      assert.deepEqual((await t.texts(".cleanup-name")).sort(), ["one", "three", "two"]);
      assert.match(await t.text("#cleanup-total"), /3 not shown in the list/);
      t.answer(0);
      await t.click("#cleanup-confirm");
      await t.until(() => t.messages.length === 1, "folder question");
      await t.settled();
      assert.match(t.messages[0].message, /Delete 3 worktrees\?/);
      assert.doesNotMatch(t.messages[0].detail, /folder that holds them/);
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
      await t.click(`${group} [data-toggle-directory]`);
    });
    await t.step("folder deletion under a search deletes matching descendants only", async () => {
      await search(t, "deep/");
      const root = "tr[data-directory-path] [data-folder-delete]";
      await t.click(root);
      await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "the review of the matching worktrees");
      assert.equal(await t.text("#cleanup-title"), "Delete these 2 worktrees?");
      assert.deepEqual((await t.texts(".cleanup-name")).sort(), ["three", "two"]);
      await t.click("#cleanup-confirm");
      await gone(t, t.world[1]); await gone(t, t.world[2]);
      assert.equal(t.messages.length, 1, "two clean worktrees, reviewed, are not asked about again");
      assert.equal(t.fixture.read("projects/group/keep.txt"), "not a worktree");
      assert.equal(t.fixture.exists(t.world[0].path), true);
      assert.equal(t.fixture.exists(t.world[3].path), true);
      await search(t, "");
      assert.equal(await t.text("#all-count"), "2");
      await statistics(t, 2);
    });
  }],
});
