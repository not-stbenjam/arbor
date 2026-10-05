"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, scans } = require("./setup-helpers.cjs");
scenario({ name: "menu refresh disabled while editing Settings", timeout: 15,
  setup(f) { f.preferences(); }, launches: [async (t) => {
    await t.settled();
    await t.click("#settings-button");
    await open(t, "settings-dialog");
    await t.fill("#scan-root", t.fixture.path("unsaved"));
    const before = scans(t).length;
    const refresh = t.menuItems().find((item) => item.path.join("/") === "File/Refresh Worktrees");
    assert.equal(refresh.enabled, false, "Refresh should not start work behind a modal editor");
    assert.equal(scans(t).length, before);
  }],
});
