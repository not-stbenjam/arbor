"use strict";

const { scenario, assert } = require("./harness.cjs");

scenario({
  name: "a row that cannot be deleted does not offer to be",
  timeout: 30,
  setup(f) {
    const tree = f.repository("projects/repo").worktree("replaced", { missing: true });
    f.write(`${tree.path}/unrelated.txt`, "not a checkout");
    f.preferences();
    return { path: tree.path };
  },
  launches: [async (t) => {
    await t.settled();
    const row = await t.row(t.world.path);
    assert.equal(await t.text(`${row} .worktree-state`), "Worktree path could not be verified");
    const menu = await t.contextMenu(`${row} .branch-cell`);
    assert.equal(menu.find((item) => item.label.startsWith("Delete “")).enabled, false);
    assert.equal(t.fixture.read(`${t.world.path}/unrelated.txt`), "not a checkout");
    assert.equal(await t.enabled(`${row} [data-delete]`), false, "row Delete must agree with its blocked label and menu");
  }],
});
