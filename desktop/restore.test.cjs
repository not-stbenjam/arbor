"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const {WorkspaceCoordinator}=require("./workspace-coordinator.cjs");
const {RecentDeletions}=require("./recent-deletions.cjs");
const row={id:"native",path:"/work/topic",repo:"repo",commonDir:"/work/repo/.git",branch:"topic",head:"a".repeat(40),detached:false,sizeBytes:10,canRemove:true,recommended:true};
const report=rows=>JSON.stringify({root:"/work",worktrees:rows,warnings:[]});

test("successful removal records losses, restore uses targeted inspection, missing removals are omitted",async()=>{
 for(const missing of [false,true]) {
 const deletions=new RecentDeletions();const calls=[];
 const coordinator=new WorkspaceCoordinator({deletions,root:"/work",run:async args=>{
  calls.push(args);
  if(args[0]==="remove")return JSON.stringify({path:row.path,removed:true,missing});
  if(args[0]==="restore")return JSON.stringify({path:row.path,restored:true,branch:row.branch,head:row.head,moved:false});
  return report([{...row,losses:["changes"]}]);
 }});
 await coordinator.start();await coordinator.waitUntilIdle();
 const state=coordinator.getState();
 const result=await coordinator.remove({items:[{id:state.report.worktrees[0].id,head:row.head}],revision:state.revision,recommendedOnly:false},async()=>true);
 assert.equal(result.results[0].removed,true);
 if(missing){assert.deepEqual(coordinator.listDeletions(),[]);continue;}
 const entries=coordinator.listDeletions();assert.equal(entries.length,1);assert.equal(entries[0].clean,false);
 assert.equal(result.results[0].restoreID,entries[0].id);
 const restored=await coordinator.restore([entries[0].id]);
 assert.equal(restored.results[0].restored,true);assert.equal(restored.report.worktrees.length,1);
 assert.deepEqual(coordinator.listDeletions(),[]);
 assert.equal(calls.filter(a=>a[0]==="list"&&!a.includes("--target-only")).length,1);
 assert.deepEqual(calls.find(a=>a[0]==="restore"),["restore","--json","--repo",row.commonDir,"--head",row.head,"--branch",row.branch,"--",row.path]);
 }
});
test("restore refuses a scanning host and keeps failed restores in history",async()=>{
 const deletions=new RecentDeletions();const entry=await deletions.add({...row,host:"",retainedBranch:"",clean:true});
 let finish;
 const coordinator=new WorkspaceCoordinator({deletions,root:"/work",run:args=>args[0]==="list"?new Promise(resolve=>{finish=()=>resolve(report([]));}):Promise.reject(Object.assign(new Error("failed"),{stdout:JSON.stringify({path:row.path,restored:false,error:"destination already exists"})}))});
 await coordinator.start();
 await assert.rejects(coordinator.restore([entry.id]),/operation/);
 finish();await coordinator.waitUntilIdle();
 const result=await coordinator.restore([entry.id]);
 assert.equal(result.results[0].error,"destination already exists");assert.equal(coordinator.listDeletions().length,1);
 await assert.rejects(coordinator.restore(["not an id"]),/valid/);
});

test("a mismatched success cannot remove a history entry", async () => {
 const deletions = new RecentDeletions();
 const entry = await deletions.add({...row,host:"",retainedBranch:"",clean:true});
 const coordinator = new WorkspaceCoordinator({deletions,root:"/work",run:async()=>JSON.stringify({path:"/another/path",branch:row.branch,head:row.head,restored:true})});
 const response = await coordinator.restore([entry.id]);
 assert.equal(response.results[0].restored,false);
 assert.equal(coordinator.listDeletions().length,1);
});
