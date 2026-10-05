"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {createFixture, createDirectory} = require("../e2e/fixture.cjs");
const f = createFixture(createDirectory("ux-extra"));
const records = [];
const run = (label, args, opts) => {
 const result = f.run(f.path("bin/arbor-cli"), args, opts);
 records.push({label,args,...result}); return result;
};
const shell = (label, command) => {
 const result = f.run("bash", ["-c", command]); records.push({label,command,...result}); return result;
};
const r = f.repository("projects/repo");
const w = r.worktree("old");
const host = f.host("review-host");
const remote = f.repository(host.relative("projects/repo")); remote.worktree("old");
// These two commands reproduce shell expansion in the original help example.
shell("remote-unquoted", 'arbor-cli list --host review-host --path ~/projects');
shell("remote-quoted", "arbor-cli list --host review-host --path '~/projects'");
for (const s of ["bash", "zsh", "fish"]) f.write(`completion.${s}`,run("completion",["completion",s]).stdout);
shell("bash-install", 'source "$ARBOR_E2E_DIRECTORY/completion.bash"; complete -p arbor');
records.push({label:"zsh-install",...f.run("zsh",["-c",'autoload -Uz compinit; compinit -d "$HOME/.zcompdump"; source "$ARBOR_E2E_DIRECTORY/completion.zsh"; whence -w _arbor'])});
for (const args of [["__complete",""],["__complete","list","--"],["__complete","list","--host", ""],["__complete","list","--path", ""]])run("completion-query",args);
// Permission warning in an otherwise readable root has a successful exit.
const denied=f.path("projects/denied");fs.mkdirSync(denied);fs.chmodSync(denied,0);
run("partial-scan-json",["list","-p",f.root,"--json"]);
run("partial-scan-clean",["clean","-p",f.root,"--json"]);fs.chmodSync(denied,0o700);
// A saved preview does not bind a later clean invocation.
run("preview-before-new",["clean","-p",f.root,"--json"]);
r.worktree("added-after-preview");
run("execute-after-new",["clean","-p",f.root,"--yes","--json"]);
assert(!fs.existsSync(w.path));
for(const width of [40,80,100,200]) {
 for(const mode of [[],["--all"],["--all","--force"]]) {
  const repo=f.repository(`cases/w${width}-${mode.length}/repo`);
  repo.worktree("merged");repo.worktree("unmerged",{commits:1});repo.worktree("dirty",{modified:true});
  for(const flags of [[],["--yes"]]) {
   const args=["clean","-p",path.dirname(repo.path),...mode,...flags];
   records.push({label:`pty-${width}-batch`,args,...f.run("python3",[path.join(__dirname,"terminal.py"),String(width),f.path("bin/arbor-cli"),...args])});
  }
 }
 const t=r.worktree(`remove-${width}`);
 for(const flags of [[],["--yes"]]) {
  const args=["remove",t.path,...flags,"--json","--progress"];
  records.push({label:`pty-${width}-remove-json`,args,...f.run("python3",[path.join(__dirname,"terminal.py"),String(width),f.path("bin/arbor-cli"),...args])});
 }
}
// Real changing HEAD, rather than a deliberately invalid expectation.
const changed=r.worktree("changed"); const before=r.head("changed");r.commit("New work",{where:changed.path});
run("changed-head",["remove",changed.path,"--head",before,"--yes"]);
// Final empty JSON contracts and remote removal modes.
run("empty-list",["list","-p",f.home,"--json"]);
run("empty-clean-preview",["clean","-p",f.home,"--json"]);
run("empty-clean-execute",["clean","-p",f.home,"--json","--yes"]);
run("remote-remove-preview",["remove",path.join(host.root,"old"),"--host",host.name,"--json"]);
run("remote-remove-execute",["remove",path.join(host.root,"old"),"--host",host.name,"--json","--yes"]);
run("remote-stats",["stats","--host",host.name,"--json"]);
f.write("review.json",JSON.stringify(records,null,2));console.log(f.directory);
