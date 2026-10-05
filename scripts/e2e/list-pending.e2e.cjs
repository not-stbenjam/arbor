"use strict";

const { scenario, assert } = require("./harness.cjs");
const { gate } = require("./list-helpers.cjs");

scenario({
  name: "pending rows cannot be deleted",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const tree = repo.worktree("checking");
    f.preferences();
    gate(f, " status ");
    return { path: tree.path };
  },
  launches: [async (t) => {
    await t.until(() => t.fixture.exists("gate-entered"), "initial scan held in Git");
    await t.until(() => t.visible(".pending-row"), "unchecked discovery row");
    const row = await t.row(t.world.path);
    await t.step("an incomplete scan shows Checking and disables deletion", async () => {
      assert.match(await t.text(row), /Checking…/);
      assert.equal(await t.enabled(`${row} [data-delete]`), false);
      const menu = await t.contextMenu(`${row} .branch-cell`);
      assert.equal(menu.find((item) => item.label.startsWith("Delete “")).enabled, false);
      await t.click(`${row} .branch-cell`);
      assert.equal(await t.text("#selection-label"), "1 worktree selected · 1 cannot be deleted");
      assert.equal(await t.enabled("#remove-selected"), false);
      assert.equal(await t.enabled("#cleanup-button"), false);
      await t.click('[data-stop-host=""]');
      await t.until(async () => /Scan incomplete/.test(await t.text(row)), "incomplete row after Stop");
      assert.match(await t.text("#host-progress-list"), /The list is incomplete/);
      assert.equal(t.fixture.exists(t.world.path), true);
      assert.equal(t.fixture.statistics(), null);
    });
    await t.step("another Refresh finishes checking and makes the row usable", async () => {
      await t.click("#refresh-button");
      await t.settled();
      assert.equal(await t.text(`${row} .worktree-state`), "Merged");
      assert.equal(await t.enabled(`${row} [data-delete]`), true);
      assert.equal(await t.text("#recommended-count"), "1");
      assert.equal(t.fixture.exists(t.world.path), true);
    });
  }],
});
