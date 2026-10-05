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
      t.answer(0);
      await t.click(`${group} [data-folder-delete]`);
      await t.until(() => t.messages.length === 1, "folder question");
      await t.settled();
      assert.match(t.messages[0].message, /1 of 3 worktrees is not clean.*delete all 3/);
      assert.match(t.messages[0].detail, /folder that holds them.*is kept/);
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
      await t.click(`${group} [data-toggle-directory]`);
    });
    await t.step("folder deletion under a search deletes matching descendants only", async () => {
      await search(t, "deep/");
      const root = "tr[data-directory-path] [data-folder-delete]";
      t.answer(1);
      await t.click(root);
      await gone(t, t.world[1]); await gone(t, t.world[2]);
      assert.match(t.messages[1].message, /Delete 2 worktrees/);
      assert.equal(t.fixture.read("projects/group/keep.txt"), "not a worktree");
      assert.equal(t.fixture.exists(t.world[0].path), true);
      assert.equal(t.fixture.exists(t.world[3].path), true);
      await search(t, "");
      assert.equal(await t.text("#all-count"), "2");
      await statistics(t, 2);
    });
  }],
});
