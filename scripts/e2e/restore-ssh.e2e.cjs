"use strict";
const {scenario,assert}=require("./harness.cjs");
const {registered}=require("./list-helpers.cjs");
scenario({name:"restore on a simulated SSH host",setup(f){
 const host=f.host("restore-host");const repo=f.repository(host.relative("projects","repo"));const tree=repo.worktree("remote-topic");
 f.preferences({scan:{host:host.name,root:host.root},hosts:[{host:host.name,name:"Restore host",root:host.root}],hostFilter:host.name});
 return {target:tree.path,repo:repo.path,contents:f.read(`${tree.path}/README.md`)};
},launches:[async t=>{
 await t.settled();t.answer(1);await t.click(`${await t.row(t.world.target)} [data-delete]`);
 await t.until(()=>!t.fixture.exists(t.world.target),"remote deletion");await t.settled();
 await t.until(()=>t.exists(".toast-undo"),"remote Undo");await t.click(".toast-undo");
 await t.until(async()=>t.fixture.exists(t.world.target)&&await t.exists(`tr[data-path=${JSON.stringify(t.world.target)}]`),"remote folder and row restored");
 assert.equal(t.fixture.read(`${t.world.target}/README.md`),t.world.contents);
 assert.equal(registered(t,t.world.repo,t.world.target),true);
 assert.ok(t.fixture.cliCalls().some(args=>args[0]==="restore"&&args.includes("restore-host")));
 await t.until(async()=>(await t.text("#toast-region"))==="Put back 1 worktree.","remote result");
}]});
