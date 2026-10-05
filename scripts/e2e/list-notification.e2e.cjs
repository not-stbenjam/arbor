"use strict";

// What was just deleted is usually followed by the next, so the note saying
// it went must not sit on a button someone is about to press.

const { scenario, assert } = require("./harness.cjs");

scenario({
  name: "a notification covers nothing there is to press",
  size: [850, 560],
  setup(fixture) {
    const repository = fixture.repository("projects/payments-api");
    for (let index = 0; index < 14; index++)
      repository.worktree(`agent-${String(index).padStart(2, "0")}-fix-retry-backoff`);
    fixture.preferences();
  },
  launches: [
    async (t) => {
      await t.settled();
      const rows = (await t.rows()).filter((row) => !row.folder);
      const row = (index) => `#worktree-list tr[data-id="${rows[index].id}"]`;
      // Everything a person might reach for next that the note is on top of.
      const covered = () =>
        t.js(`(() => {
          const note = document.querySelector("#toast-region .toast").getBoundingClientRect();
          return [...document.querySelectorAll("[data-delete], [data-folder-delete], .row-menu, #selection-bar button, #selection-label, #status-message, #sidebar-footer *")]
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.width && note.left < box.right && box.left < note.right && note.top < box.bottom && box.top < note.bottom;
            })
            .map((element) => element.id || element.className);
        })()`);
      await t.step("after one deletion, with the list longer than the window", async () => {
        t.answer("Delete Worktree");
        await t.click(`${row(2)} [data-delete]`);
        await t.until(() => t.exists("#toast-region .toast"), "the note that it went");
        await t.settled();
        assert.match(await t.text("#toast-region"), /Deleted 1 worktree/);
        assert.deepEqual(await covered(), []);
      });
      await t.step("with rows ticked, and the bar that acts on them showing", async () => {
        await t.click(`${row(0)} .branch-copy`);
        await t.click(`${row(1)} .branch-copy`);
        assert.equal(await t.visible("#selection-bar"), true);
        assert.equal(await t.exists("#toast-region .toast"), true, "the note is still up");
        assert.deepEqual(await covered(), []);
      });
      await t.step("at the default size too", async () => {
        await t.resize(1240, 800);
        assert.deepEqual(await covered(), []);
      });
    },
  ],
});
