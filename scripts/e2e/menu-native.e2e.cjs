"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, menuRole } = require("./setup-helpers.cjs");
scenario({ name: "native editing zoom and window menu roles", timeout: 20,
  setup(f) { f.preferences(); }, launches: [async (t) => {
    await t.settled();
    const role = (name) => menuRole(t, name);
    await t.click("#settings-button");
    await open(t, "settings-dialog");
    await t.fill("#scan-root", "first");
    await t.type(" second");
    await role("selectall");
    await role("cut");
    assert.equal(await t.value("#scan-root"), "");
    await role("undo");
    assert.equal(await t.value("#scan-root"), "first second");
    await role("redo");
    assert.equal(await t.value("#scan-root"), "");
    await role("paste");
    assert.equal(await t.value("#scan-root"), "first second");
    await role("selectall");
    await role("copy");
    await t.press("End");
    await role("paste");
    assert.equal(await t.value("#scan-root"), "first secondfirst second");
    await t.press("Escape");
    await role("zoomin");
    assert.ok(t.page.getZoomFactor() > 1);
    await role("resetzoom");
    assert.equal(t.page.getZoomFactor(), 1);
    await role("zoomout");
    assert.ok(t.page.getZoomFactor() < 1);
    await role("resetzoom");
    await role("toggledevtools");
    await t.until(() => t.page.isDevToolsOpened(), "developer tools open");
    await role("toggledevtools");
    await t.until(() => !t.page.isDevToolsOpened(), "developer tools close");
    // Close is a real menu action; this launch is deliberately over afterwards.
    await role("close");
  }],
});
