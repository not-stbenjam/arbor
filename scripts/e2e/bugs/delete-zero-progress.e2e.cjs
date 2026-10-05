"use strict";

const { scenario, assert } = require("../harness.cjs");
const { gate, release } = require("../list-helpers.cjs");

scenario({
  name: "deletion omits initial file count",
  timeout: 30,
  setup(f) {
    const tree = f.repository("projects/repo").worktree("held", { ignored: { "a.log": "keep until confirmed" } });
    f.preferences();
    gate(f, " worktree remove ");
    return { path: tree.path };
  },
  launches: [async (t) => {
    await t.settled();
    t.answer(1);
    await t.click(`${await t.row(t.world.path)} [data-delete]`);
    await t.until(() => t.fixture.exists("gate-entered"), "real Git deletion held");
    try {
      await t.until(() => t.visible(".host-progress-file"), "a real file reported by the CLI");
      assert.equal(t.fixture.exists(t.world.path), true);
      assert.match(await t.text("#host-progress-list"), /0 of 4 files/, "README, ignore file, Git pointer and local log are still present");
    } finally {
      await release(t);
      await t.settled();
    }
  }],
});
