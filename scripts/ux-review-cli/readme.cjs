"use strict";
const fs=require("node:fs");
const {createDirectory,createFixture}=require("../e2e/fixture.cjs");
const f=createFixture(createDirectory("ux-readme"));
const r=f.repository("projects/repo");
const host=f.host("my-vps"); f.repository(host.relative("projects/repo")).worktree("remote");
f.tool("arbor",`exec '${f.path("bin/arbor-cli")}' "$@"`);
const records=[];
const lines=fs.readFileSync("README.md","utf8").split("\n");
for(const [i,line] of lines.entries()) {
 if(!line.startsWith("arbor ") && line!=="arbor" && !line.startsWith("/Applications/Arbor.app/Contents/Resources/bin/arbor-cli "))continue;
 if(line.startsWith("arbor gui")){records.push({line:i+1,command:line,skipped:"GUI launch prohibited; command help tested separately"});continue;}
 const target=r.worktree(`example-${i}`);
 let command=(line.endsWith("&&") ? [line, lines[i+1], lines[i+2]].join("\n") : line).replace('/Applications/Arbor.app/Contents/Resources/bin/arbor-cli','arbor')
  .replaceAll('"$HOME/git"',`'${f.root}'`).replaceAll('"$HOME"',`'${f.home}'`)
  .replaceAll('/absolute/path/to/worktree',`'${target.path}'`).replaceAll('/path/to/worktree',`'${target.path}'`)
  .replaceAll('/absolute/path/to/old-sessions',`'${f.root}'`).replaceAll('/path/to/repository',`'${r.path}'`)
  .replaceAll('/home/dev/projects',`'${host.root}'`);
 if(command.includes('/missing/worktree')) {
  fs.rmSync(target.path,{recursive:true});command=command.replaceAll('/missing/worktree',`'${target.path}'`);
 }
 const result=f.run("bash",["-c",command]);records.push({line:i+1,original:line,command,...result});
}
f.write("review.json",JSON.stringify(records,null,2));console.log(JSON.stringify({directory:f.directory,commands:records.length}));
