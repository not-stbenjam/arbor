"use strict";
const fs=require('node:fs');
const path=require('node:path');
const {scenario,assert}=require('./harness.cjs');
scenario({
  name:'missing HEAD and nested linked checkout',timeout:30,
  setup(f){
    const r=f.repository('projects/repo');const broken=r.worktree('missing-head');
    const admin=f.git(broken.path,'rev-parse','--absolute-git-dir');fs.unlinkSync(path.join(admin,'HEAD'));
    const outer=r.worktree('outer');const inner=r.worktree('inner',{at:path.join(outer.path,'inner')});
    f.write('projects/sentinel','keep');f.preferences();return{broken:broken.path,outer:outer.path,inner:inner.path};
  },
  launches:[async t=>{
    await t.settled();
    const broken=await t.worktree(t.world.broken);
    assert.ok(broken,'registered checkout with missing HEAD remains visible');
    assert.equal(broken.canRemove,false);assert.equal(broken.canDiscard,false);
    assert.match(await t.text(await t.row(t.world.broken)),/Cannot|could not|No commit/);
    const outer=await t.worktree(t.world.outer);assert.ok(outer.losses.includes('nested'));assert.equal(outer.recommended,false);
    t.answer(box=>{assert.match(box.detail,/separate Git repository or worktree/);return 0;});
    await t.click(`${await t.row(t.world.outer)} [data-delete]`);await t.settled();
    assert.ok(t.fixture.exists(t.world.inner));assert.equal(t.fixture.read('projects/sentinel'),'keep');
  }],
});
