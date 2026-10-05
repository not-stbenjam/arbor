"use strict";

const { scenario, assert } = require("../harness.cjs");

scenario({
  name: "last deletion drops keyboard focus",
  timeout: 30,
  setup(f) {
    const tree = f.repository("projects/repo").worktree("last");
    f.preferences();
    return { path: tree.path };
  },
  launches: [async (t) => {
    await t.settled();
    await t.click(`${await t.row(t.world.path)} .branch-cell`);
    t.answer(1);
    await t.press("Backspace");
    await t.until(() => t.visible("[data-choose-folder]"), "empty state action");
    await t.settled();
    assert.equal(t.fixture.exists(t.world.path), false);
    assert.equal(await t.attribute("#worktree-grid", "aria-activedescendant"), null);
    await t.until(async () => /button/.test(await t.focused()), "keyboard focus on an available empty-state action", 2000);
  }],
});
