"use strict";
const { scenario, assert } = require("./harness.cjs");
const { focus, tabTo, replace } = require("./stress-helpers.cjs");
scenario({
  name: "keyboard first launch setup", timeout: 30,
  setup(f) { f.repository("projects/repo").worktree("ready"); return {}; },
  launches: [async t => {
    await t.until(() => t.js("document.querySelector('#setup-dialog').open"), "setup");
    await focus(t, "#setup-local");
    await t.press("Tab"); await focus(t, "#setup-root");
    await replace(t, t.fixture.root);
    await t.press("Tab"); await focus(t, "#setup-choose-folder");
    t.choose(t.fixture.root); await t.press("Enter"); await focus(t, "#setup-choose-folder");
    assert.equal(t.choosers.length, 1);
    await t.press("Tab"); await focus(t, "#setup-next"); await t.press("Enter");
    await focus(t, "#setup-title");
    await tabTo(t, "#setup-github"); assert.equal(await t.checked("#setup-github"), false);
    await t.press("Tab"); await focus(t, "#setup-fetch");
    await t.press("Tab"); await focus(t, "#setup-step-2 summary"); await t.press("Enter");
    await t.press("Tab"); await focus(t, "#setup-excludes");
    await tabTo(t, "#setup-next"); await t.press("Enter"); await focus(t, "#setup-title");
    assert.equal(await t.text("#setup-review-root"), t.fixture.root);
    await tabTo(t, "#setup-back"); await t.press("Enter"); await focus(t, "#setup-title");
    await tabTo(t, "#setup-next"); await t.press("Enter");
    await tabTo(t, "#setup-start"); await t.press("Enter");
    await t.settled();
    await t.until(() => t.js("!document.querySelector('#setup-dialog').open"), "setup closes");
    // The keyboard is handed to the list the scan is filling.
    await t.until(async () => await t.count('.worktree-row') === 1, 'scan painted');
    await focus(t, "#worktree-grid");
  }],
});
