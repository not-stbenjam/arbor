"use strict";
const {scenario,assert}=require('../harness.cjs');
const {scaleFixture,tabTo}=require('../stress-helpers.cjs');
scenario({
  name:'Page Down keeps the active row visible',timeout:30,
  setup:f=>scaleFixture(f,30),
  launches:[async t=>{
    await t.settled(); await t.painted();await tabTo(t,'#worktree-grid');
    await t.press('PageDown');
    // Native smooth scrolling may still be in flight; wait for its result.
    await t.until(()=>t.js("document.querySelector('#table-scroll').scrollTop>document.querySelector('#table-scroll').clientHeight/2"),'page scroll');
    const visible=await t.js("(()=>{const a=document.querySelector('.is-current').getBoundingClientRect(),b=document.querySelector('#table-scroll').getBoundingClientRect();return a.bottom>b.top&&a.top<b.bottom})()");
    assert.equal(visible,true,'Page Down must move the active descendant with the visible page');
  }],
});
