"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, noScan } = require("./setup-helpers.cjs");
scenario({ name: "menu refresh disabled before setup consent", timeout: 15,
  launches: [async (t) => {
    await open(t, "setup-dialog");
    await noScan(t);
    assert.equal(await t.enabled("#refresh-button"), false);
    const refresh = t.menuItems().find((item) => item.path.join("/") === "File/Refresh Worktrees");
    assert.equal(refresh.enabled, false, "the native menu must agree with the disabled Refresh button");
  }],
});
