"use strict";
const {scenario,assert}=require('./harness.cjs');
const {layout,tabTo,replace}=require('./stress-helpers.cjs');
scenario({
  name:'setup steps fit and scroll at zoom',timeout:30,
  setup(f){f.repository('projects/repo').worktree('ready');},
  launches:[async t=>{
    await t.until(()=>t.js("document.querySelector('#setup-dialog').open"),'setup');
    await tabTo(t,'#setup-root');await replace(t,t.fixture.root);
    for(const step of [1,2,3]) {
      for(const [w,h] of [[850,560],[1600,1000]]) {
        await t.zoom(1);await t.resize(w,h);
        // 300% in the minimum window is isolated in bugs/zoom-page-overflow.
        for(const zoom of (w===850 ? [.5,1,1.5,2] : [.5,1,1.5,2,3])) {
          await t.zoom(zoom);
          assert.deepEqual(await layout(t,'#setup-dialog'),[],`setup step ${step}, ${w}x${h}, ${zoom*100}%`);
        }
      }
      await t.zoom(1);
      if(step<3){await tabTo(t,'#setup-next');await t.press('Enter');}
    }
  }],
});
