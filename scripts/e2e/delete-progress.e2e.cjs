"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone, gate, release, closeWindow } = require("./list-helpers.cjs");

scenario({
  name: "delete progress guards window close",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const tree = record(repo.worktree("deleting", { ignored: { "node_modules/a": 1000, "node_modules/b": 1000 } }));
    f.preferences();
    gate(f, " worktree remove ");
    return tree;
  },
  launches: [async (t) => {
    await t.settled();
    try {
      await t.step("real deletion reports file progress and disables competing actions", async () => {
        t.answer(1);
        await t.click(`${await t.row(t.world.path)} [data-delete]`);
        await t.until(() => t.fixture.exists("gate-entered"), "Git at removal");
        await t.until(() => t.visible(".host-progress-file"), "current file in deletion progress");
        // The missing initial file count has its own failing reproducer in
        // bugs/delete-zero-progress.e2e.cjs.
        assert.match(await t.text("#host-progress-list"), /Deleting worktree/);
        assert.equal(await t.attribute(".host-progress-path", "title"), t.world.path);
        assert.equal(await t.visible("progress.host-progress-bar"), true);
        assert.equal(await t.enabled("#refresh-button"), false);
        assert.equal(await t.enabled("#cleanup-button"), false);
        assert.equal(await t.enabled(`${await t.row(t.world.path)} [data-delete]`), false);
        assert.equal(await t.exists("[data-stop-host]"), false, "deletion is finished, not interrupted halfway");
        assert.equal(t.fixture.exists(t.world.path), true);
      });
      await t.step("closing mid-delete asks; Keep Arbor Open lets deletion finish", async () => {
        t.answer(0);
        // Native window chrome is outside the page. This is Electron's actual
        // window close request, not a synthetic DOM event or backend command.
        closeWindow(t);
        await t.until(() => t.messages.length === 2, "close question");
        assert.equal(t.messages[1].message, "Finish the current worktree, then quit?");
        assert.deepEqual(t.messages[1].buttons, ["Keep Arbor Open", "Finish Current & Quit"]);
        assert.equal(t.window.isDestroyed(), false);
      });
    } finally {
      await release(t);
    }
    await t.step("the real Git deletion completes and updates statistics", async () => {
      await gone(t, t.world);
      assert.equal(t.fixture.statistics().removedWorktrees, 1);
      assert.equal(await t.visible("#scan-progress"), false);
    });
  }],
});
