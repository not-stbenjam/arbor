"use strict";
const { scenario, assert } = require("./harness.cjs");
const { saved, scans, open, closed, cached } = require("./setup-helpers.cjs");
scenario({ name: "settings save discard and reset", timeout: 25,
  setup(f) {
    const old = f.repository("projects/old").worktree("old-tree").path;
    const repo = f.repository("other/repo");
    const kept = repo.worktree("kept").path;
    const skipped = repo.worktree("skip-me").path;
    const history = repo.worktree("already-deleted").path;
    assert.equal(f.cli("remove", history, "--yes").status, 0);
    f.preferences();
    return { old, kept, skipped, root: f.path("other") };
  }, launches: [async (t) => {
    await t.settled();
    await t.step("Escape and close discard scan edits without a scan", async () => {
      const before = saved(t), count = scans(t).length;
      for (const close of ["escape", "button"]) {
        await t.click("#settings-button");
        await open(t, "settings-dialog");
        await t.fill("#scan-root", t.world.root);
        await t.click("#scan-fetch");
        if (close === "escape") await t.press("Escape");
        else await t.click("[aria-label='Close settings']");
        await closed(t, "settings-dialog");
        assert.deepEqual(saved(t), before);
      }
      assert.equal(scans(t).length, count);
    });
    await t.step("Save uses the chosen folder and exact options", async () => {
      await t.menu("File", "Settings…");
      await open(t, "settings-dialog");
      assert.equal(await t.value("#scan-root"), t.fixture.root);
      t.choose(t.world.root);
      await t.click("#choose-folder");
      await t.click("#scan-fetch");
      await t.click("#scan-github");
      await t.click("#settings-dialog summary");
      await t.click("#scan-reset-excludes");
      assert.match(await t.value("#scan-excludes"), /node_modules/);
      await t.fill("#scan-excludes", "skip-me");
      const count = scans(t).length;
      await t.click("#settings-save", { count: 2 });
      await closed(t, "settings-dialog");
      await t.settled();
      assert.equal(scans(t).length, count + 1);
      assert.equal(saved(t).scan.root, t.world.root);
      assert.deepEqual(saved(t).scan.excludes, ["skip-me"]);
      assert.ok(saved(t).scan.github && saved(t).scan.fetch);
      assert.equal((await t.rows()).filter((r) => !r.folder).length, 1);
      await cached(t, t.world.kept);
    });
    await t.step("Reset can be cancelled, then clears cache without deleting Git data", async () => {
      await t.click("#settings-button");
      const before = saved(t), statistics = t.fixture.statistics();
      assert.equal(statistics.removedWorktrees, 1);
      t.answer("Cancel");
      await t.click("#reset-preferences");
      await t.until(() => t.messages.length === 1, "reset confirmation");
      assert.deepEqual(saved(t), before);
      const calls = scans(t).length;
      t.answer("Reset Arbor");
      await t.click("#reset-preferences");
      await open(t, "setup-dialog");
      assert.equal(saved(t).setupCompleted, false);
      assert.deepEqual(t.fixture.statistics(), statistics);
      assert.deepEqual(JSON.parse(t.fixture.read("user-data/workspace-cache.json")).entries, []);
      assert.equal(scans(t).length, calls);
      for (const p of [t.world.old, t.world.kept, t.world.skipped]) assert.ok(t.fixture.exists(p));
    });
  }],
});
