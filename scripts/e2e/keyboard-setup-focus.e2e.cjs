"use strict";
const { scenario, assert } = require("./harness.cjs");
const { tabTo, replace } = require("./stress-helpers.cjs");
scenario({
  name: "setup must return visible keyboard focus", timeout: 30,
  setup(f) { f.repository("projects/repo").worktree("ready"); },
  launches: [async t => {
    await t.until(()=>t.js("document.querySelector('#setup-dialog').open"),'setup');
    await tabTo(t,'#setup-root'); await replace(t,t.fixture.root);
    for(let i=0;i<2;i++) { await tabTo(t,'#setup-next'); await t.press('Enter'); }
    await tabTo(t,'#setup-start'); await t.press('Enter');
    await t.until(()=>t.js("!document.querySelector('#setup-dialog').open"),'setup closes');
    await t.settled(); await t.painted();
    assert.doesNotMatch(await t.focused(), /^body(?:\.|$)/, 'setup must hand focus to a visible workspace control');
    assert.equal(await t.visible(':focus'),true);
  }],
});
