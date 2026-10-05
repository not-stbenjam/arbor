"use strict";
const {scenario,assert}=require('./harness.cjs');
const {scaleFixture,tabTo,focus,layout}=require('./stress-helpers.cjs');
scenario({
  name:'large refresh can be stopped from keyboard',timeout:120,
  setup:f=>scaleFixture(f,200),
  launches:[async t=>{
    await t.settled();await t.until(async()=>await t.count('.worktree-row')===200,'all rows');
    await tabTo(t,'#refresh-button');await t.press('Enter');
    await t.until(()=>t.visible('[data-stop-host]'),'Stop');
    assert.deepEqual(await layout(t, "#scan-progress"),[], 'scanning keeps controls separated');
    await tabTo(t,'[data-stop-host]');await t.press('Enter');
    await t.until(async()=>!(await t.state()).busy,'scan stops');
    await t.until(()=>t.visible('#refresh-button'),'refresh');
    await focus(t,'#refresh-button');
    assert.equal((await t.state()).cancelled,true);
    assert.equal((await t.state()).report.worktrees.length,200);
    for(const p of t.world.paths)assert.ok(t.fixture.exists(p));
  }],
});
