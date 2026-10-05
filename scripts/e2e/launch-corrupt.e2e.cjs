"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, saved, cached } = require("./setup-helpers.cjs");
scenario({ name: "launch corrupt preferences and older cache", timeout: 20,
  setup(f) {
    f.write("user-data/preferences.json", "{broken");
    f.write("user-data/workspace-cache.json", "{broken");
    return { tree: f.repository("projects/repo").worktree("safe").path };
  }, launches: [async (t) => {
    await open(t, "setup-dialog");
    assert.equal(await t.text("#setup-step-label"), "1 of 3");
    assert.equal(t.fixture.cliCalls().filter((a) => a[0] === "list").length, 0);
    assert.deepEqual(t.fixture.connections(), []);
    assert.ok(t.fixture.exists(t.world.tree));
    await t.fill("#setup-root", t.fixture.root);
    await t.click("#setup-next");
    await t.click("#setup-next");
    await t.click("#setup-start");
    await t.settled();
    await cached(t, t.world.tree);
    assert.equal(saved(t).setupCompleted, true);
    t.fixture.write("user-data/workspace-cache.json", JSON.stringify({ version: 0, entries: [] }));
    // Older saved preferences had no per-host scans.
    const p = saved(t); delete p.scans;
    t.fixture.write("user-data/preferences.json", JSON.stringify(p));
  }, async (t) => {
    await t.settled();
    assert.equal(await t.js("document.querySelector('#setup-dialog').open"), false);
    assert.match(await t.text(await t.row(t.world.tree)), /safe/);
    assert.match(await t.text("#scan-time"), /^Scanned/);
    await cached(t, t.world.tree);
    t.fixture.write("user-data/workspace-cache.json", "{broken again");
  }, async (t) => {
    await t.settled();
    assert.match(await t.text(await t.row(t.world.tree)), /safe/);
    await cached(t, t.world.tree);
    assert.equal(t.fixture.statistics(), null);
  }],
});
