"use strict";
const {scenario,assert}=require('./harness.cjs');
const {open,close,accessible,contrast,tabTo,focus,ring}=require('./stress-helpers.cjs');
scenario({
  name:'dialog contrast and statistics keyboard', timeout:30,
  setup(f) {
    const r=f.repository('projects/repo'); r.worktree('merged');
    const gone=r.worktree('previous');
    const result=f.cli('remove','--yes','--',gone.path); assert.equal(result.status,0,result.stderr);
    r.worktree('broken'); f.write('projects/broken/.git','gitdir: invalid\n');
    f.preferences();
  },
  launches:[async t=>{
    await t.settled();
    for(const theme of ['light','dark']) {
      if(theme==='dark') await t.click('#theme-button');
      for(const [b,d] of [['#settings-button','#settings-dialog'],['#statistics-button','#statistics-dialog'],['#add-host','#machine-dialog'],['#cleanup-button','#cleanup-dialog'],['#warning-button','#notes-dialog']]) {
        await open(t,b,d,true);
        if(d==='#statistics-dialog') {
          await t.until(()=>t.count('.statistics-plot'),'charts');
          await tabTo(t,'.statistics-plot'); await ring(t);
          for(const [key,value] of [['Home','1'],['Right','2'],['End','30'],['Left','29']]) {
            await t.press(key); await focus(t,'.statistics-plot');
            assert.equal(await t.attribute(':focus','aria-valuenow'),value);
          }
        }
        await accessible(t);
        const readings=await contrast(t,d);
        console.log(`CONTRAST ${theme} ${d} ${JSON.stringify(readings.filter(r=>r.ratio<r.minimum))}`);
        assert.deepEqual(readings.filter(r=>!r.disabled&&r.ratio<r.minimum),[],`${theme} ${d} text contrast`);
        await close(t,b,d);
      }
    }
  }],
});
