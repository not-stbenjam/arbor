"use strict";
const fs=require('node:fs');
const path=require('node:path');
const {scenario,assert}=require('./harness.cjs');
scenario({
  name:'read-only removal preserves checkout files',timeout:30,
  setup(f){const r=f.repository('projects/repo');const tree=r.worktree('readonly');const keep=r.worktree('keep');f.write('projects/sentinel','keep');fs.chmodSync(tree.path,0o555);f.preferences();return {target:tree.path,keep:keep.path};},
  launches:[async t=>{
    try {
      await t.settled();t.answer('Delete Worktree');await t.click(`${await t.row(t.world.target)} [data-delete]`);
      await t.until(()=>t.visible('#error-banner'),'permission error');await t.settled();
      assert.ok(t.fixture.exists(t.world.target));assert.ok(t.fixture.exists(path.join(t.world.target,'README.md')));
      assert.match(await t.text('#error-message'),/read-only.*Make it writable/s);
      assert.ok(t.fixture.exists(t.world.keep));assert.equal(t.fixture.read('projects/sentinel'),'keep');
      // That the row stays and deletes once writable is in delete-read-only;
      // this scenario checks what is beside it.

    } finally {if(t.fixture.exists(t.world.target))fs.chmodSync(t.world.target,0o755);}
  }],
});
