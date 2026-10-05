"use strict";
const {scenario,assert}=require('../harness.cjs');
const {layout}=require('../stress-helpers.cjs');
scenario({
  name:'minimum window at 300 percent has no page overflow',timeout:30,
  setup(f){f.repository('projects/repo').worktree('ready');},
  launches:[async t=>{
    await t.until(()=>t.js("document.querySelector('#setup-dialog').open"),'setup');
    await t.resize(850,560);await t.zoom(3);
    assert.deepEqual(await layout(t,'#setup-dialog'),[],'300% setup viewport');
  }],
});
