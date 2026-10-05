"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createDirectory, createFixture} = require("../e2e/fixture.cjs");
const f=createFixture(createDirectory("ux-recipes"));
const r=f.repository("projects/repo",{hoursOld:1500});
const old=r.worktree("old with\nnewline",{branch:"old",hoursOld:1000});
const recent=r.worktree("recent");
const dirty=r.worktree("dirty",{modified:true});
f.backdate(old.path,1000);f.backdate(f.git(old.path,"rev-parse","--absolute-git-dir"),1000);
const host=f.host("review-host");f.repository(host.relative("projects/repo")).worktree("remote-old");
f.write("failed.json",JSON.stringify([{path:old.path,removed:false,error:"temporary device failure"}]));
const records=[];
const listing=f.cli("list","-p",f.root,"--json");assert.equal(listing.status,0);
f.write("worktrees.json",listing.stdout);
const checked=f.run("jq",["-e","(.warnings | length) == 0 and all(.worktrees[]; (.problems | length) == 0)",f.path("worktrees.json")]);assert.equal(checked.status,0);
const paths=f.run("jq",["-j",'.worktrees[] | select(.recommended) | .path + "\\u0000"',f.path("worktrees.json")]);
assert.equal(paths.status,0);assert(paths.stdout.includes(old.path+"\0"));
for(const mode of ["inventory","paths","remote","space","retry","aged"]) {
 const result=f.run("python3",[path.join(__dirname,"recipes.py"),mode]);
 assert.equal(result.status,0,JSON.stringify({mode,...result}));records.push({mode,...result});
}
assert(!fs.existsSync(old.path));assert(fs.existsSync(recent.path));assert(fs.existsSync(dirty.path));
assert(records.find(r=>r.mode==="paths").stdout.includes(old.path+"\0"));
f.write("review.json",JSON.stringify(records,null,2));console.log(f.directory);
