"use strict";
const { scenario, assert } = require("../harness.cjs");
const { open, saved } = require("../setup-helpers.cjs");
scenario({ name: "settings missing folder keeps editable error", timeout: 20,
  setup(f) { f.preferences(); }, launches: [async (t) => {
    await t.settled();
    const before = saved(t);
    await t.click("#settings-button");
    await open(t, "settings-dialog");
    await t.fill("#scan-root", t.fixture.path("does-not-exist"));
    await t.click("#settings-save");
    await t.until(async () => (await t.visible("#settings-error")) || (await t.visible("#error-banner")), "folder refusal");
    assert.equal(await t.js("document.querySelector('#settings-dialog').open"), true,
      "a refused folder must stay editable in Settings");
    assert.match(await t.text("#settings-error"), /no such|does not exist/i);
    assert.equal(saved(t).scan.root, before.scan.root);
  }],
});
