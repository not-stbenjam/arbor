"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RecentDeletions } = require("./recent-deletions.cjs");
const { deletionEntry, restoreSelection } = require("./protocol.cjs");
const value = { host: "", path: "/projects/topic", repo: "repo", commonDir: "/projects/repo/.git", branch: "topic", head: "a".repeat(40), detached: false, retainedBranch: "", sizeBytes: 12, clean: true };

test("recent deletions survive reopening, expire, and keep at most 200 newest", async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arbor-history-"));
 t.after(() => fs.rm(dir,{recursive:true,force:true}));
 const filename = path.join(dir,"history.json");
 let now = Date.now();
 const store = await RecentDeletions.open(filename, () => now);
 for(let i=0;i<205;i++) { now++; await store.add({...value,path:`/projects/${i}`}); }
 const rows = store.list(); assert.equal(rows.length,200); assert.equal(rows[0].path,"/projects/204");
 const reopened = await RecentDeletions.open(filename,()=>now);
 assert.deepEqual(reopened.list(),rows);
 assert.deepEqual(reopened.list(["remote"]),[]);
 await reopened.remove(rows[0].id);
 assert.equal((await RecentDeletions.open(filename,()=>now)).list().length,199);
 now += 30*24*60*60*1000;
 assert.deepEqual(reopened.list(),[]);
 assert.deepEqual((await fs.readdir(dir)),["history.json"]);
});
test("invalid history and invalid entries never authorize a restore", async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"arbor-history-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const filename=path.join(dir,"history.json");
 for(const data of ["invalid",JSON.stringify({version:1,entries:[null,{...value,id:"unsafe",deletedAt:Date.now()}]}),JSON.stringify({version:2,entries:[]})]) {
  await fs.writeFile(filename,data);assert.deepEqual((await RecentDeletions.open(filename)).list(),[]);
 }
});
test("restore protocol accepts only bounded unique history IDs and validated entries", async () => {
 const store=new RecentDeletions();const row=await store.add(value);
 assert.deepEqual(restoreSelection([row.id]),[row.id]);
 for(const request of [null,[],[row.id,row.id],[value], ["--repo"], [row.id + "\n"], Array(201).fill(row.id)]) assert.throws(()=>restoreSelection(request));
 for(const change of [{detached:true},{id:row.id+"\n"},{head:"a".repeat(40)+"\n"},{host:"-bad"},{path:"relative"},{commonDir:""},{head:"HEAD"},{clean:"yes"},{sizeBytes:-1},{deletedAt:NaN},{branch:""},{retainedBranch:"a\0b"}]) assert.throws(()=>deletionEntry({...row,...change}));
});
test("Undo requires every deletion to have a record and reports discarded work and failures", async () => {
 const {undoAction,restoreNotice}=await import("./renderer/restore-controller.mjs");
 let ids;
 const action=undoAction([{restoreID:"one"},{restoreID:"two"}],value=>{ids=value;});
 assert.equal(action.label,"Undo");action.run();assert.deepEqual(ids,["one","two"]);
 for(const rows of [[],[{}],[{restoreID:"one"},{missing:true}]]) assert.equal(undoAction(rows,()=>{}),undefined);
 assert.equal(restoreNotice([{restored:true,clean:true},{restored:true,clean:true}]).message,"Put back 2 worktrees.");
 assert.equal(restoreNotice([{restored:true,clean:false}]).message,"Put back 1 worktree. The uncommitted files it had were discarded and are not back.");
 const failed=restoreNotice([{restored:false,path:"/bad\u202epath",error:"already exists"}]);
 assert.equal(failed.error,true);assert.match(failed.message,/already exists/);assert.ok(!failed.message.includes("\u202e"));
 assert.match(restoreNotice([{restored:true,clean:true,moved:true}]).message,/branch has moved/);
});
