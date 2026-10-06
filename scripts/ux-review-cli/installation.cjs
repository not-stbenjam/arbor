"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createFixture,createDirectory,realCLI}=require("../e2e/fixture.cjs");
const f=createFixture(createDirectory("ux-install"));
// Whatever release this checkout builds, so the exercise does not go stale.
const version=`v${require("../../package.json").version}`;
const name=`arbor_${version}_linux_amd64`;
const staged=f.path("staging",name);
fs.mkdirSync(staged,{recursive:true});fs.copyFileSync(realCLI(),path.join(staged,"arbor"));
const records=[];
function run(command,args,options){const r=f.run(command,args,options);records.push({command,args,...r});assert.equal(r.status,0,r.stderr);return r;}
run("tar",["-czf",f.path(name+".tar.gz"),"-C",f.path("staging"),name]);
run("tar",["-xzf",f.path(name+".tar.gz")]);
run("mkdir",["-p",f.path("home/.local/bin")]);
const destination=f.path("home/.local/bin/arbor");
run("install",["-m","755",f.path(name,"arbor"),destination]);
assert.equal(run(destination,["version"]).stdout,`arbor ${version}\n`);
f.write("home/.config/arbor/statistics.json","preserve statistics\n");
run("install",["-m","755",f.path(name,"arbor"),destination]);
assert.equal(run(destination,["version"]).stdout,`arbor ${version}\n`);
run("rm",[destination]);assert(!fs.existsSync(destination));
assert.equal(f.read("home/.config/arbor/statistics.json"),"preserve statistics\n");
f.write("review.json",JSON.stringify(records,null,2));console.log(f.directory);
