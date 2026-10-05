"use strict";
const {scenario,assert}=require('../harness.cjs');
const {contrast}=require('../stress-helpers.cjs');
scenario({
  name:'disabled cleanup text remains readable', timeout:30,
  setup(f){f.repository('projects/repo').worktree('dirty',{modified:true});f.preferences();},
  launches:[async t=>{
    await t.settled(); await t.painted();
    // Disabled controls are exempt from WCAG AA; the requested stress bar
    // explicitly includes them, so keep this stricter expectation separate.
    const failures=(await contrast(t)).filter(r=>r.disabled&&r.ratio<r.minimum);
    assert.deepEqual(failures,[],'disabled text meets the requested 4.5:1 readability bar');
  }],
});
