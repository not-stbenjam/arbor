"use strict";
const {scenario,assert}=require('../harness.cjs');
const {layout}=require('../stress-helpers.cjs');
scenario({
  name:'minimum window at 200 percent retains controls', timeout:30,
  setup(f) {f.repository('projects/repo').worktree('merged');f.preferences();},
  launches:[async t=>{
    await t.settled(); await t.painted(); await t.resize(850,560); await t.zoom(2);
    assert.deepEqual(await layout(t),[], 'sidebar controls must fit or have a scroll route');
  }],
});
