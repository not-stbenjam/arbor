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
      assert.equal(await t.text("#selection-label"), "3 worktrees selected · 1 with data to discard");
      // Several at once are first shown in full: every one, with what
      // deleting it means.
      await t.click("#remove-selected");
      await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "the review of the selection");
      assert.equal(await t.text("#cleanup-title"), "Delete these 3 worktrees?");
      assert.deepEqual(await t.texts(".cleanup-name"), ["a-safe", "b-dirty", "c-stale"]);
      assert.deepEqual(await t.js("[...document.querySelectorAll('.cleanup-item')].map((item) => item.dataset.tone)"), ["safe", "risk", "safe"]);
      assert.match((await t.texts(".cleanup-reason"))[1], /^Uncommitted changes$/);
      assert.match(await t.text("#cleanup-lead"), /Branches and commits are kept; uncommitted files are discarded\./);
      assert.match(await t.text("#cleanup-lead"), /uncommitted files are discarded/);
      assert.equal(await t.text("#cleanup-confirm"), "Delete 3 worktrees…");
      assert.equal(t.messages.length, 0, "nothing is asked until the review is agreed to");
      // Agreeing asks once more, by name, because one of them would lose work.
      t.answer(0);
      await t.click("#cleanup-confirm");
      await t.until(() => t.messages.length === 1, "selection question");
      await t.settled();
      assert.equal(t.messages[0].title, "Delete worktrees?");
      assert.match(t.messages[0].message, /Delete 3 worktrees\?/);
      assert.match(t.messages[0].detail, /Discards uncommitted changes\./);
      assert.doesNotMatch(t.messages[0].detail, /folder that holds them/);
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
    });
    await t.step("a clean member becoming dirty fails without discarding it; other members finish", async () => {
      const [safe, dirty, stale] = t.world;
      t.fixture.write(`${stale.path}/new-work.txt`, "arrived after the scan");
      t.answer(1);
      await t.click("#remove-selected");
      await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "the review of the selection");
      await t.click("#cleanup-confirm");
      await gone(t, safe); await gone(t, dirty);
      await t.until(() => t.visible("#error-banner"), "failed row explanation");
      assert.match(await t.text("#error-message"), /c-stale.*Uncommitted or untracked files/);
      // What to do next is said in the window's terms, not as flags.
      assert.match(await t.text("#error-message"), /Not deleted\. It has changed since the list was read.*its row now shows what it holds/);
      assert.doesNotMatch(await t.text("#error-message"), /--force|--yes/);
      assert.equal(t.fixture.read(`${stale.path}/new-work.txt`), "arrived after the scan");
      assert.equal(registered(t, stale.repository, stale.path), true);
      assert.equal(await t.text(`${await t.row(stale.path)} .worktree-state`), "1 changed file");
      assert.match(await t.text("#toast-region"), /Deleted 2 worktrees/);
      await selected(t, ["c-stale"]);
      assert.equal(await t.text("#selection-label"), "1 worktree selected · 1 with data to discard");
      assert.equal(await t.text("#all-count"), "1");
      assert.equal(t.fixture.statistics().cleanupSessions, 1);
      await statistics(t, 2);
      assert.equal(t.fixture.cliCalls().filter((args) => args[0] === "list" && !args.includes("--target-only")).length, 1, "cleanup does not rescan the workspace");
    });
  }],
});
