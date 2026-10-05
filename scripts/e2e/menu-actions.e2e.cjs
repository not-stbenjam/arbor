"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, closed, scans } = require("./setup-helpers.cjs");
scenario({ name: "application menu commands and shortcuts", timeout: 20,
  setup(f) { f.preferences(); f.repository("projects/repo").worktree("listed"); },
  launches: [async (t) => {
    await t.settled();
    await t.menu("File", "Settings…");
    await open(t, "settings-dialog");
    await t.fill("#scan-root", t.fixture.path("draft"));
    await t.menu("File", "Settings…");
    assert.equal(await t.value("#scan-root"), t.fixture.path("draft"));
    await t.press("Escape");
    await closed(t, "settings-dialog");
    await t.menu("Edit", "Find Worktree");
    assert.match(await t.focused(), /search/);
    await t.type("listed");
    assert.equal((await t.rows()).filter((r) => !r.folder).length, 1);
    await t.press("Control+a");
    await t.press("Backspace");
    await t.menu("File", "Add SSH Host…");
    await open(t, "machine-dialog");
    assert.match(await t.focused(), /host-input/);
    await t.press("Escape");
    await t.menu("File", "Statistics…");
    await open(t, "statistics-dialog");
    await t.press("Escape");
    const count = scans(t).length;
    await t.menu("File", "Refresh Worktrees");
    await t.until(() => scans(t).length === count + 1, "menu refresh scans");
    await t.settled();
    await t.menu("Help", "Arbor on GitHub");
    await t.menu("Help", "Report an Issue");
    assert.deepEqual(t.opened.map((x) => x.target), ["https://github.com/stbenjam/arbor", "https://github.com/stbenjam/arbor/issues"]);
    // Native accelerators are attempted, never replaced with synthetic DOM events.
    await t.press("Control+,");
    const settings = await t.js("document.querySelector('#settings-dialog').open");
    console.log(`    Ctrl+, native accelerator delivered: ${settings}`);
    assert.equal(settings, true);
    await t.press("Escape");
    await t.click("#status-message");
    await t.press("Control+f");
    assert.match(await t.focused(), /search/);
    const shortcutCount = scans(t).length;
    await t.press("Control+r");
    await t.until(() => scans(t).length > shortcutCount, "Ctrl+R refreshes");
    await t.settled();
    await t.click("#status-message");
    await t.press("/");
    assert.match(await t.focused(), /search/);
    assert.equal(t.fixture.statistics(), null);
  }],
});
