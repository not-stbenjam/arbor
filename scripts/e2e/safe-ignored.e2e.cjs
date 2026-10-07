"use strict";
const {scenario, assert} = require("./harness.cjs");
const defaults = require("../../internal/config/defaults.json").safeIgnored;

scenario({
 name:"safe ignored files locally and over SSH", size:[1240,820], timeout:180,
 setup(f) {
  const repo=f.repository("projects/repo",{ignore:["node_modules/",".env","custom-output/"]});
  const safe=repo.worktree("safe-merged",{merged:true,ignored:{"node_modules/cache":"generated"}});
  const unmerged=repo.worktree("safe-unmerged",{commits:1,ignored:{"node_modules/cache":"generated"}});
  const mixed=repo.worktree("mixed",{ignored:{"node_modules/cache":"generated",".env":"secret"}});
  const custom=repo.worktree("custom",{ignored:{"custom-output/cache":"generated"}});
  const nested=repo.worktree("nested",{ignored:{"node_modules/cache":"generated"}});
  f.repository("projects/nested/node_modules/clone",{remote:false});
  const host=f.host("safe-host");
  const remote=f.repository(host.relative("projects/repo"));
  const remoteSafe=remote.worktree("remote-safe",{at:host.relative("projects/remote-safe"),ignored:{"node_modules/cache":"generated"}});
  f.preferences({hosts:[{host:host.name,name:"Test SSH",root:host.root}],hostFilter:"",scans:[{root:f.root,host:"",excludes:[]},{root:host.root,host:host.name,excludes:[]}]});
  return {safe:safe.path,unmerged:unmerged.path,mixed:mixed.path,custom:custom.path,nested:nested.path,remote:remoteSafe.path};
 },
 launches:[async t=>{
  await t.settled();
  await t.until(async()=> (await t.worktree(t.world.safe))?.recommended,"safe default recommendation");
  assert.match(await t.text(await t.row(t.world.safe)),/Merged · Ignored files marked safe/);
  assert.match(await t.text(await t.row(t.world.unmerged)),/Ignored files marked safe/);
  assert.match(await t.text(await t.row(t.world.mixed)),/Ignored files/);
  assert.match(await t.text(await t.row(t.world.nested)),/Nested repository/);
  assert.equal((await t.worktree(t.world.nested)).recommended,false);
  // Capture the actual window in both appearances and widths. No mock markup.
  for(const theme of ["light","dark"]) {
   if(theme==="dark") await t.click("#theme-button");
   for(const width of [1240,850]) {
    await t.resize(width,820);
    await t.screenshot(`safe-rows-${theme}-${width}`);
    await t.click("#settings-button");
    assert.match(await t.text("#safe-ignored-setting summary"), /Ignored files considered safe to delete/);
    assert.ok(await t.exists("#safe-ignored-setting summary .icon"));
    assert.equal(await t.text("#scan-safe-ignored-count"), `${defaults.length} patterns`);
    if(await t.js("document.querySelector('#safe-ignored-setting').open")) {
     await t.click("#safe-ignored-setting summary");
    }
    await t.screenshot(`safe-settings-collapsed-${theme}-${width}`);
    if(!(await t.attribute("#safe-ignored-setting","open"))) {
     const opened=await t.js("document.querySelector('#safe-ignored-setting').open");
     if(!opened) await t.click("#safe-ignored-setting summary");
    }
    await t.fill("#scan-safe-ignored", "custom-output");
    assert.equal(await t.text("#scan-safe-ignored-count"), "1 pattern");
    await t.fill("#scan-safe-ignored", "");
    assert.equal(await t.text("#scan-safe-ignored-count"), "None");
    await t.click("#scan-reset-safe-ignored");
    assert.equal(await t.text("#scan-safe-ignored-count"), `${defaults.length} patterns`);
    await t.screenshot(`safe-settings-${theme}-${width}`);
    await t.press("Escape");
    await t.click("#cleanup-button");
    assert.match(await t.text("#cleanup-list"),/Ignored files marked safe: node_modules/);
    await t.screenshot(`safe-review-${theme}-${width}`);
    await t.click("#cleanup-cancel");
    await t.click(`${await t.row(t.world.mixed)} [data-show-files]`);
    await t.until(()=>t.exists("#files-content .files-group"),"mixed inventory");
    const inventory = await t.text("#files-content");
    assert.match(inventory, /Needs review/);
    assert.match(inventory, /Considered safe by your settings/);
    assert.ok(inventory.indexOf(".env") < inventory.indexOf("Considered safe by your settings"));
    assert.ok(inventory.indexOf("Considered safe by your settings") < inventory.indexOf("node_modules"));
    assert.doesNotMatch(inventory, /Marked safe|Not marked safe/);
    await t.screenshot(`safe-files-${theme}-${width}`);
    await t.press("Escape");
   }
  }
  await t.step("removing a default and adding a custom rule refreshes recommendations",async()=>{
   await t.click("#settings-button");
   await t.fill("#scan-safe-ignored",defaults.filter(r=>r!=="node_modules").join("\n"));
   await t.click("#settings-save");
   await t.until(async()=> (await t.worktree(t.world.safe))?.allIgnoredSafe===false,"removed rule applied");
   await t.settled();
   assert.equal((await t.worktree(t.world.safe)).recommended,false);
   assert.match(await t.text(await t.row(t.world.safe)),/Ignored files/);
   await t.click("#settings-button");
   await t.fill("#scan-safe-ignored","custom-output");
   await t.click("#settings-save");
   await t.until(async()=> (await t.worktree(t.world.custom))?.recommended,"custom rule applied");
   await t.settled();
   await t.click("#settings-button");
   await t.click("#scan-reset-safe-ignored");
   assert.equal(await t.value("#scan-safe-ignored"),defaults.join("\n"));
   await t.click("#settings-save");
   await t.until(async()=> (await t.worktree(t.world.safe))?.recommended,"defaults restored");
   await t.settled();
  });
  await t.step("Delete recommended needs no discard question and Undo reports the lost files",async()=>{
   const before=t.messages.length;
   await t.click("#cleanup-button");await t.click("#cleanup-confirm");
   await t.until(()=>!t.fixture.exists(t.world.safe),"safe folder deleted");await t.settled();
   assert.equal(t.messages.length,before);
   assert.ok(t.fixture.exists(t.world.mixed));assert.ok(t.fixture.exists(t.world.nested));
   await t.click(".toast-undo");
   await t.until(()=>t.fixture.exists(t.world.safe),"Undo restored folder");
   await t.until(async()=> /Ignored files are not restored/.test(await t.text("#toast-region")),"honest Undo notice");
   assert.equal(t.fixture.exists(`${t.world.safe}/node_modules`),false);
  });
  await t.step("simulated SSH uses the same rules for list, files and removal",async()=>{
   await t.click("#machine-button");await t.click('[data-host="safe-host"]');await t.settled();
   await t.until(async()=> (await t.worktree(t.world.remote))?.recommended,"remote safe recommendation");
   await t.click(`${await t.row(t.world.remote)} [data-show-files]`);
   await t.until(()=>t.exists("#files-content .files-group"),"remote inventory");
   assert.match(await t.text("#files-content"),/Considered safe by your settings/);await t.press("Escape");
   const before=t.messages.length;await t.click("#cleanup-button");await t.click("#cleanup-confirm");
   await t.until(()=>!t.fixture.exists(t.world.remote),"remote deleted");await t.settled();
   assert.equal(t.messages.length,before);
  });
 }],
});
