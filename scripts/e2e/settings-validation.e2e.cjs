"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, saved, scans } = require("./setup-helpers.cjs");
scenario({ name: "settings invalid exclusions stay editable", timeout: 25,
  setup(f) { f.preferences(); }, launches: [async (t) => {
    await t.settled();
    const before = saved(t), count = scans(t).length;
    await t.click("#settings-button");
    await open(t, "settings-dialog");
    await t.click("#settings-dialog summary");
    await t.fill("#scan-excludes", "skip-0");
    for (let i = 1; i < 129; i++) {
      await t.press("Enter");
      await t.type(`skip-${i}`);
    }
    assert.equal((await t.value("#scan-excludes")).split("\n").length, 129);
    await t.click("#settings-save");
    await t.until(() => t.visible("#settings-error"), "validation explains the limit");
    assert.match(await t.text("#settings-error"), /up to 128 excluded folders/);
    assert.equal(await t.js("document.querySelector('#settings-dialog').open"), true);
    assert.equal((await t.value("#scan-excludes")).split("\n").length, 129);
    assert.deepEqual(saved(t), before);
    assert.equal(scans(t).length, count);
    await t.fill("#scan-excludes", "corrected");
    await t.click("#settings-save");
    await t.until(() => scans(t).length === count + 1, "corrected scan starts");
    await t.settled();
    assert.deepEqual(saved(t).scan.excludes, ["corrected"]);
  }],
});
