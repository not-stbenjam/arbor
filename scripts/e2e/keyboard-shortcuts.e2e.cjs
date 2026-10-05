"use strict";
const { scenario, assert } = require("./harness.cjs");
const { tabTo, focus } = require("./stress-helpers.cjs");
scenario({
  name: "native search and settings accelerators", timeout: 30,
  setup(f) { f.repository("projects/repo").worktree("ready"); f.preferences(); },
  launches: [async t => {
    await t.settled();
    await tabTo(t, "#worktree-grid");
    await t.press("Control+f"); await focus(t, "#search");
    await t.type("ready"); await t.press("Escape");
    assert.equal(await t.value("#search"), "");
    await t.press("Control+,");
    await t.until(() => t.js("document.querySelector('#settings-dialog').open"), "Settings accelerator");
    await focus(t, "#settings-host");
    await t.press("Escape"); await focus(t, "#search");
  }],
});
