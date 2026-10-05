"use strict";
const {scenario,assert}=require('../harness.cjs');
scenario({
  name:'bidi controls must not invisibly reorder row names', timeout:30,
  setup(f) {const r=f.repository('projects/repo');r.worktree('safe\u202egnp.exe');f.preferences();},
  launches:[async t=>{
    await t.settled(); await t.painted();await t.until(()=>t.count('.worktree-row'),'row');
    assert.equal(await t.js("/[\\u202a-\\u202e\\u2066-\\u2069]/.test(document.querySelector('.worktree-path').textContent)"),false,'show an explicit control marker, as the review already does');
  }],
});
