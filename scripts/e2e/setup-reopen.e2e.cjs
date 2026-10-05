"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, noScan, saved } = require("./setup-helpers.cjs");
scenario({ name: "setup abandoned draft and empty folder", timeout: 20,
  launches: [async (t) => {
    await open(t, "setup-dialog");
    await t.fill("#setup-root", t.fixture.root);
    await t.click("#setup-next");
    await t.click("#setup-fetch");
    await noScan(t);
    assert.equal(t.fixture.exists("user-data/preferences.json"), false);
    // The native close is the same window action as its title-bar button.
    t.window.close();
  }, async (t) => {
    await open(t, "setup-dialog");
    assert.equal(await t.text("#setup-step-label"), "1 of 3");
    await noScan(t);
    await t.fill("#setup-root", t.fixture.root);
    await t.click("#setup-next");
    assert.equal(await t.checked("#setup-fetch"), false);
    await t.click("#setup-next");
    await t.click("#setup-start");
    await t.settled();
    assert.match(await t.text("#empty-state"), /No .*worktrees/i);
    assert.equal(saved(t).scan.root, t.fixture.root);
    assert.equal(t.fixture.statistics(), null);
  }],
});
