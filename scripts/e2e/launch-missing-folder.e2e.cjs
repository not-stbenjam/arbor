"use strict";
const fs = require("node:fs");
const { scenario, assert } = require("./harness.cjs");
const { saved, open, cached } = require("./setup-helpers.cjs");
scenario({ name: "launch vanished folder and recovery", timeout: 20,
  setup(f) {
    fs.mkdirSync(f.path("vanishing"));
    const tree = f.repository("projects/repo").worktree("safe").path;
    f.preferences({ scan: { root: f.path("vanishing") } });
    fs.rmdirSync(f.path("vanishing"));
    return { tree };
  }, launches: [async (t) => {
    await t.settled();
    await t.until(() => t.visible("#error-banner"), "missing saved folder error");
    assert.match(await t.text("#error-message"), /folder does not exist: .*vanishing/is);
    assert.ok(t.fixture.exists(t.world.tree));
    // The list says the same and offers the way out, with or without the banner.
    assert.match(await t.text("#empty-state"), /The folder to scan is not there\s+.*vanishing does not exist on this computer/s);
    assert.deepEqual(await t.texts("#empty-state button"), ["Choose another folder…", "Scan again"]);
    assert.match(await t.text("#status-message"), /this computer not scanned/);
    await t.click("#dismiss-error");
    assert.equal(await t.visible("#error-banner"), false);
    await t.click("#settings-button");
    await open(t, "settings-dialog");
    await t.fill("#scan-root", t.fixture.root);
    await t.click("#settings-save");
    await cached(t, t.world.tree);
    await t.until(async () => (await t.rows()).some((r) => r.text.includes("safe")), "recovered list drawn");
    await t.settled();
    assert.equal(saved(t).scan.root, t.fixture.root);
    assert.match(await t.text(await t.row(t.world.tree)), /safe/);
    assert.equal(await t.visible("#error-banner"), false);
    await cached(t, t.world.tree);
  }],
});
