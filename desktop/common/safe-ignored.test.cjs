"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {scanOptions, validatePreferences, DEFAULT_SAFE_IGNORED} = require("../protocol.cjs");
const {worktreeState, worktreeStateKind, projectTree} = require("../renderer/worktree-presentation.mjs");
const {deletionMeaning} = require("../renderer/cleanup-controller.mjs");
const {filesContent} = require("../renderer/files-controller.mjs");
const {restoreNotice} = require("../renderer/restore-controller.mjs");
const {removalArguments} = require("../removal-policy.cjs");

test("safe ignored preference defaults, validation and explicit empty lists", () => {
 assert.deepEqual(scanOptions().safeIgnored, DEFAULT_SAFE_IGNORED);
 assert.deepEqual(validatePreferences({scan:{safeIgnored:[]}}).scan.safeIgnored, []);
 for (const safeIgnored of [null, "cache", [""], ["["], ["../cache"], ["/cache"], ["~/cache"], ["x\\"], ["[a/b]"], Array(129).fill("cache")]) assert.throws(()=>scanOptions({safeIgnored}));
 const copy=scanOptions();copy.safeIgnored[0]="changed";assert.equal(scanOptions().safeIgnored[0],"node_modules");
 assert.deepEqual(scanOptions({safeIgnored:["**/build", "*.pyc", "name[0-9]", "a, b"]}).safeIgnored,["**/build", "*.pyc", "name[0-9]", "a, b"]);
});
test("safe ignored rows retain state kinds and concise honest review wording", () => {
 const row={id:"safe",path:"/work/safe",branch:"topic",repo:"repo",canRemove:true,canDiscard:true,ignored:true,allIgnoredSafe:true,matchedSafeIgnored:["node_modules"],losses:[],recommended:true,merged:true};
 assert.equal(worktreeStateKind(row),"Merged");
 assert.equal(worktreeState(row).label,"Merged · Ignored files marked safe");
 assert.match(worktreeState(row).detail,/node_modules/);
 assert.match(deletionMeaning(row).notes[0],/Ignored files marked safe: node_modules/);
 const unmerged={...row,recommended:false,merged:false};
 assert.equal(worktreeStateKind(unmerged),"Not merged");
 assert.equal(worktreeState(unmerged).label,"Ignored files marked safe");
 const mixed={...row,canRemove:false,recommended:false,allIgnoredSafe:false,losses:["ignored"]};
 assert.equal(worktreeState(mixed).label,"Ignored files");
 const nested={...row,canRemove:false,recommended:false,losses:["nested"]};
 assert.match(worktreeState(nested).label,/repository/i);
 const args=removalArguments(row,{safeIgnored:["custom*"],statsSession:"test"});
 assert.ok(args.includes("--no-default-safe-ignored"));assert.ok(args.includes("custom*"));assert.ok(!args.includes("node_modules"));assert.ok(!args.includes("--discard-local"));
 const tree=require("./worktree-tree.mjs");
 assert.equal(projectTree([row],{root:"/work",hostFilter:"",hosts:[],repo:"",view:"all",search:"ignored",sort:"path",collapsedDirectories:new Set()},tree).filtered.length,1);
});
test("inventory marks each ignored entry and Undo names lost safe files", () => {
 const html=filesContent({counts:{ignored:2},entries:[{kind:"ignored",path:"node_modules",safeIgnored:true,safeIgnoredRule:"node_modules",sizeBytes:1},{kind:"ignored",path:".env",safeIgnored:false,sizeBytes:2}],warnings:[]});
 assert.match(html,/Marked safe · node_modules/);assert.match(html,/Not marked safe/);
 assert.equal(restoreNotice([{restored:true,clean:false,safeIgnoredOnly:true}]).message,"Put back 1 worktree. Ignored files are not restored.");
});
