"use strict";
const { scenario, assert } = require("./harness.cjs");
const { scaleFixture, layout } = require("./stress-helpers.cjs");
scenario({
  name: "pending rows and scan progress layout", timeout: 30,
  setup: f => scaleFixture(f, 200),
  launches: [async t => {
    await t.until(() => t.count(".pending-row"), "discovered pending rows");
    assert.equal(await t.js("[...document.querySelectorAll('.pending-row [data-delete]')].every(e=>e.disabled)"), true);
    assert.deepEqual(await layout(t), [], "progress and pending rows fit without overlapping controls");
    await t.settled();
    await t.until(async () => await t.count(".worktree-row") === 200 && await t.count(".pending-row") === 0, "all rows checked");
    assert.equal((await t.state()).report.worktrees.length, 200);
  }],
});
