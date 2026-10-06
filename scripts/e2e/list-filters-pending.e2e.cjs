"use strict";
const { scenario, assert } = require("./harness.cjs");
const { gate, release } = require("./list-helpers.cjs");
const { select } = require("./setup-helpers.cjs");
scenario({
  name: "a state filter follows a pending row through inspection",
  setup(f) {
    f.repository("projects/repo").worktree("checking");
    f.preferences();
    gate(f, " status ");
  },
  launches: [
    async (t) => {
      await t.until(() => t.visible(".pending-row"), "a pending row");
      assert.deepEqual(await t.texts("#state-filter option"), [
        "Any state",
        "Checking (1)",
      ]);
      await select(t, "#state-filter", 1);
      assert.equal(await t.count(".pending-row"), 1);
      await release(t);
      await t.settled();
      assert.equal(await t.value("#state-filter"), "Checking");
      assert.equal(
        await t.text("#state-filter option:checked"),
        "Checking (0)",
      );
      assert.equal(await t.count(".worktree-row"), 0);
      assert.match(await t.text("#empty-state p"), /State: Checking/);
      await t.click("[data-clear-filters]");
      assert.equal(await t.count(".worktree-row"), 1);
      assert.equal(await t.text(".worktree-state"), "Merged");
    },
  ],
});
