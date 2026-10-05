"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, noScan, holdEnter, cached, scans } = require("./setup-helpers.cjs");
scenario({ name: "held Enter cannot skip setup consent", timeout: 20,
  setup(f) { return { tree: f.repository("projects/repo").worktree("safe").path }; },
  launches: [async (t) => {
    await open(t, "setup-dialog");
    await t.fill("#setup-root", t.fixture.root);
    await holdEnter(t);
    assert.equal(await t.text("#setup-step-label"), "2 of 3");
    await noScan(t);
    await t.click("#setup-next");
    assert.equal(await t.text("#setup-step-label"), "3 of 3");
    await noScan(t);
    await t.press("Tab", { times: 2 });
    assert.match(await t.focused(), /setup-start/);
    await holdEnter(t);
    await cached(t, t.world.tree);
    await t.until(async () => (await t.rows()).some((r) => r.text.includes("safe")), "one completed scan drawn");
    assert.equal(scans(t).length, 1);
    assert.ok(t.fixture.exists(t.world.tree));
    assert.equal(t.fixture.statistics(), null);
  }],
});
