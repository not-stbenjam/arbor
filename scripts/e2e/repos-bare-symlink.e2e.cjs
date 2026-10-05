"use strict";
const fs=require('node:fs');
const {scenario,assert}=require('./harness.cjs');
scenario({
  name:'bare repositories and symlink scan root', timeout:30,
  setup(f) {
    const source=f.repository('source',{remote:false});
    const bare=f.path('projects/backing.git');
    f.git(f.directory,'clone','--bare','-q',source.path,bare);
    const target=f.path('projects/linked');
    f.gitWith(f.dated(72),bare,'worktree','add','-qb','topic',target,'main');
    fs.symlinkSync(f.root,f.path('alias'));
    f.preferences({scan:{root:f.path('alias')}});
    return {bare,target,head:source.head()};
  },
  launches:[async t=>{
    await t.settled();
    const rows=(await t.state()).report.worktrees;
    assert.equal(rows.length,1); assert.equal(rows[0].path,t.world.target); assert.equal(rows[0].recommended,true);
    assert.equal(await t.count('.worktree-row'),1);
    await t.click('#cleanup-button'); await t.until(()=>t.js("document.querySelector('#cleanup-dialog').open"),'review');
    await t.click('#cleanup-confirm'); await t.until(()=>!t.fixture.exists(t.world.target),'checkout gone'); await t.settled();
    assert.ok(t.fixture.exists(t.world.bare));
    assert.equal(t.fixture.git(t.world.bare,'rev-parse','refs/heads/topic'),t.world.head);
    assert.ok(fs.lstatSync(t.fixture.path('alias')).isSymbolicLink());
  }],
});
