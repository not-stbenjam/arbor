"use strict";
const {scenario,assert}=require('./harness.cjs');
const {layout,open,close}=require('./stress-helpers.cjs');
scenario({
  name:'selection empty warning and error layouts',timeout:30,
  setup(f){const r=f.repository('projects/repo');r.worktree('merged');r.worktree('broken');f.write('projects/broken/.git','gitdir: invalid\n');f.preferences();return{broken:f.path('projects/broken')};},
  launches:[async t=>{
    await t.settled();await t.resize(850,560);
    for(const theme of ['light','dark']) {
      if(theme==='dark')await t.click('#theme-button');
      await t.click('#select-all');assert.deepEqual(await layout(t),[],'selection bar');
      await t.click('#clear-selection');
      await t.click(`${await t.row(t.world.broken)} [data-delete]`);
      await t.until(()=>t.visible('#error-banner'),'error');assert.deepEqual(await layout(t),[],'error banner');
      await t.click('#dismiss-error');
      await open(t,'#warning-button','#notes-dialog');assert.deepEqual(await layout(t,'#notes-dialog'),[],'notes');await close(t,'#warning-button','#notes-dialog');
      await t.press('/');await t.type('no-matching-worktrees');await t.until(()=>t.visible('#empty-state'),'empty search');
      assert.deepEqual(await layout(t),[],'empty search');await t.press('Escape');
    }
  }],
});
