"use strict";
const {scenario,assert}=require('./harness.cjs');
const {scaleFixture}=require('./stress-helpers.cjs');
scenario({
  name:'scan and deletion announcements', timeout:30,
  setup:f=>scaleFixture(f,100),
  launches:[async t=>{
    await t.settled(); await t.until(async()=>await t.count('.worktree-row')===100,'initial rows');
    // Observation only. The observer owns no application state and is removed
    // when the user-visible completion arrives, rather than after a sleep.
    const announcements=t.js(`new Promise(resolve=>{
      const region=document.querySelector('#announcement'), seen=[];
      const observer=new MutationObserver(()=>{
        const text=region.textContent.trim(); seen.push(text);
        if(text==='Finished.' && seen.length>1) { observer.disconnect(); resolve(seen); }
      }); observer.observe(region,{childList:true,subtree:true,characterData:true});
    })`);
    await t.click('#refresh-button');
    const messages=await announcements;
    assert.ok(messages.some(m=>/Checking|Finding|Scanning/.test(m)),JSON.stringify(messages));
    assert.equal(messages.at(-1),'Finished.');
    assert.ok(messages.every((m,i)=>i===0||m!==messages[i-1]),'unchanged scan stage is not repeated');
    await t.settled();
    await t.press('/');await t.type('delete-0000');
    await t.until(async()=>await t.count('.worktree-row')===1,'one result');
    await t.click('#cleanup-button'); await t.until(()=>t.js("document.querySelector('#cleanup-dialog').open"),'review');
    await t.click('#cleanup-confirm');
    await t.until(async()=>/Deleted 1 worktree/.test(await t.text('#toast-region')),'deletion result');
    assert.equal(await t.attribute('#toast-region','aria-live'),'polite');
    await t.settled();
    assert.equal(t.fixture.exists(t.world.paths[0]),false);
  }],
});
