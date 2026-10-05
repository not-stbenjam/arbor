"use strict";
const { scenario, assert } = require("../harness.cjs");
const { open, noScan } = require("../setup-helpers.cjs");
scenario({ name: "setup missing folder remains correctable", timeout: 20,
  launches: [async (t) => {
    await open(t, "setup-dialog");
    await t.fill("#setup-root", t.fixture.path("absent"));
    await t.click("#setup-next");
    await t.click("#setup-next");
    await noScan(t);
    await t.click("#setup-start");
    await t.until(async () => (await t.visible("#setup-error")) || (await t.visible("#error-banner")), "invalid folder refused");
    assert.equal(await t.js("document.querySelector('#setup-dialog').open"), true,
      "an invalid first scan folder should remain correctable in setup");
    assert.match(await t.text("#setup-error"), /folder does not exist/);
  }],
});
