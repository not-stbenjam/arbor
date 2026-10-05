"use strict";
const {scenario,assert}=require('../harness.cjs');
const {scaleFixture}=require('../stress-helpers.cjs');
scenario({
  name:'running cleanup offers a Stop control',timeout:30,
  setup:f=>scaleFixture(f,20),
  launches:[async t=>{
    await t.settled(); await t.painted();await t.until(async()=>await t.count('.worktree-row')===20,'rows');
    await t.click('#cleanup-button');await t.until(()=>t.js("document.querySelector('#cleanup-dialog').open"),'review');
    await t.click('#cleanup-confirm');await t.until(async()=>(await t.state()).removing,'deletion starts');
    await t.until(()=>t.visible('#scan-progress'), 'deletion progress painted');
    const stop=await t.js("[...document.querySelectorAll('[data-stop-host],#stop-scan')].some(e=>e.checkVisibility()&&!e.disabled)");
    // Let the real deletion settle before deliberately failing, so the bug
    // reproducer leaves no backend subprocess running after Electron exits.
    await t.until(()=>t.world.paths.every(p=>!t.fixture.exists(p)),'deletions settle');await t.settled(); await t.painted();
    assert.equal(stop,true,'allow finishing the current checkout and stopping the remaining batch without quitting');
  }],
});
