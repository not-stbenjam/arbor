"use strict";

// A clean row's Delete is specified to need no question. The renderer sends
// forceConfirm for every manual deletion, so this currently asks and cancels.
const { scenario, assert } = require("../harness.cjs");

scenario({
  name: "clean Delete asks unnecessarily",
  timeout: 30,
  setup(f) {
    const tree = f.repository("projects/repo").worktree("clean");
    f.preferences();
    return { path: tree.path };
  },
  launches: [async (t) => {
    await t.settled();
    const row = await t.row(t.world.path);
    assert.equal(await t.text(`${row} .worktree-state`), "Merged");
    // Answer an unexpected question safely so the failure is our assertion.
    t.answer(0);
    await t.click(`${row} [data-delete]`);
    await t.until(() => t.messages.length > 0 || !t.fixture.exists(t.world.path), "clean deletion or unexpected question");
    await t.settled();
    assert.deepEqual({ questions: t.messages.map((message) => message.message), exists: t.fixture.exists(t.world.path) }, { questions: [], exists: false });
  }],
});
