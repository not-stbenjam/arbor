"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone, selected, statistics, registered } = require("./list-helpers.cjs");

scenario({
  name: "delete selection partial failure",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = [repo.worktree("a-safe"), repo.worktree("b-dirty", { modified: true }), repo.worktree("c-stale")].map(record);
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("mixed selection explains counts and Cancel keeps every file", async () => {
      await t.click("#select-all");
      assert.equal(await t.text("#selection-label"), "3 worktrees selected · 1 not clean");
      t.answer(0);
      await t.click("#remove-selected");
      await t.until(() => t.messages.length === 1, "selection question");
      await t.settled();
      assert.equal(t.messages[0].title, "Not a clean delete");
      assert.match(t.messages[0].message, /1 of 3 worktrees is not clean.*delete all 3/);
      assert.match(t.messages[0].detail, /uncommitted changes and untracked files \(1 worktree\)/);
      assert.match(t.messages[0].detail, /folder that holds them.*is kept/);
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
    });
    await t.step("a clean member becoming dirty fails without discarding it; other members finish", async () => {
      const [safe, dirty, stale] = t.world;
      t.fixture.write(`${stale.path}/new-work.txt`, "arrived after the scan");
      t.answer(1);
      await t.click("#remove-selected");
      await gone(t, safe); await gone(t, dirty);
      await t.until(() => t.visible("#error-banner"), "failed row explanation");
      assert.match(await t.text("#error-message"), /c-stale.*Uncommitted or untracked files/);
      assert.equal(t.fixture.read(`${stale.path}/new-work.txt`), "arrived after the scan");
      assert.equal(registered(t, stale.repository, stale.path), true);
      assert.equal(await t.text(`${await t.row(stale.path)} .worktree-state`), "1 changed file");
      assert.match(await t.text("#toast-region"), /Deleted 2 worktrees/);
      await selected(t, ["c-stale"]);
      assert.equal(await t.text("#selection-label"), "1 worktree selected · 1 not clean");
      assert.equal(await t.text("#all-count"), "1");
      assert.equal(t.fixture.statistics().cleanupSessions, 1);
      await statistics(t, 2);
      assert.equal(t.fixture.cliCalls().filter((args) => args[0] === "list" && !args.includes("--target-only")).length, 1, "cleanup does not rescan the workspace");
    });
  }],
});
