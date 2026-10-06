"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone, statistics } = require("./list-helpers.cjs");

scenario({
  name: "manual deletion retains clean branch history",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const offline = f.repository("projects/offline", { remote: false });
    const other = f.repository("projects/other", { branch: "release" });
    const trees = [
      repo.worktree("merged", { commits: 1, merged: true }),
      repo.worktree("squash", { commits: 1, merged: "squash" }),
      repo.worktree("unpushed", { commits: 1 }),
      repo.worktree("pushed", { commits: 1, pushed: true }),
      repo.worktree("today", { hoursOld: 0 }),
      offline.worktree("no-remote"), other.worktree("different-default"),
    ].map(record);
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("manual Delete retains each branch and its exact commit", async () => {
      for (const tree of t.world) {
        // The extra clean-delete question is covered as a failing contract
        // in bugs/clean-delete-asks.e2e.cjs. Here exercise its confirmed result.
        t.answer(1);
        await t.click(`${await t.row(tree.path)} [data-delete]`);
        await gone(t, tree);
        assert.match(t.messages.at(-1).detail, /Its branch and commits are kept/);
        assert.equal(t.fixture.exists(tree.repository), true);
        await t.click('#toast-region button[aria-label="Dismiss notification"]');
      }
      assert.equal(await t.text("#all-count"), "0");
      await statistics(t, 7);
    });
  }],
});
