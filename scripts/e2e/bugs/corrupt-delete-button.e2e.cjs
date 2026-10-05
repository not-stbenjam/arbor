"use strict";
const {scenario,assert}=require('../harness.cjs');
scenario({
  name:'unverifiable checkout must not offer Delete', timeout:30,
  setup(f) {const r=f.repository('projects/repo');const w=r.worktree('broken');f.write('projects/broken/.git','gitdir: invalid\n');f.preferences();return {path:w.path};},
  launches:[async t=>{
    await t.settled(); await t.painted(); const w=await t.worktree(t.world.path);
    assert.equal(w.canRemove,false);assert.equal(w.canDiscard,false);
    assert.equal(await t.enabled(`${await t.row(t.world.path)} [data-delete]`),false,'cannot-delete row must disable Delete');
  }],
});
