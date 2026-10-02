"use strict";

// Run with Electron under a desktop session (or xvfb-run). All preferences and
// scan data are isolated fixtures; this never scans or removes user worktrees.
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const resumed = process.env.ARBOR_FLOW_PHASE === "resume";
const directory = resumed
  ? process.env.ARBOR_FLOW_DIRECTORY
  : fs.mkdtempSync(path.join(os.tmpdir(), "arbor-desktop-flow-"));
if (!directory || !path.basename(directory).startsWith("arbor-desktop-flow-"))
  throw new Error("Expected an isolated desktop flow fixture");
const calls = path.join(directory, "calls.jsonl");
const root = path.join(directory, "projects");
const userData = path.join(
  directory,
  resumed ? "user-data-restart" : "user-data",
);
const preferences = path.join(userData, "preferences.json");
const binary = path.join(directory, "fixture-cli");
if (!resumed) {
  fs.mkdirSync(root);
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
const root = args[args.indexOf('--path')+1];
const trees = Array.from({length:3}, (_,i)=>({id:'tree-'+i,path:root+'/tree-'+i,repo:'fixture',branch:'topic-'+i,head:'a'.repeat(40),commonDir:root+'/.git',blockers:[],problems:[],publishedRefs:[],canRemove:true,recommended:true}));
function progress(p) { process.stderr.write('@arbor-progress '+JSON.stringify(p)+'\\n'); }
setTimeout(()=>progress({stage:'discovery',path:root,discovered:1,completed:0,total:0,worktree:{...trees[0],branch:''},pending:true}),100);
setTimeout(()=>progress({stage:'inspect',path:trees[0].path,discovered:3,completed:1,total:3,worktree:trees[0],pending:false}),800);
setTimeout(()=>progress({stage:'inspect',path:trees[1].path,discovered:3,completed:2,total:3,worktree:trees[1],pending:false}),1600);
setTimeout(()=>process.stdout.write(JSON.stringify({root,worktrees:trees,warnings:[],scannedAt:new Date().toISOString(),durationMs:3500})),3500);
`,
    { mode: 0o700 },
  );
}
if (resumed) {
  fs.mkdirSync(userData);
  fs.copyFileSync(
    path.join(directory, "user-data", "preferences.json"),
    preferences,
  );
}
app.setPath("userData", userData);
process.env.ARBOR_CLI_PATH = binary;
delete process.env.ARBOR_SMOKE_TEST;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await fn();
    if (result) return result;
    await pause(80);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
const deadline = setTimeout(() => {
  console.error("Desktop flow timed out");
  app.exit(1);
}, 45000);

app.once("browser-window-created", (_event, win) => {
  if (process.env.ARBOR_FLOW_COMPACT === "1") win.setSize(850, 560);
  win.webContents.once("did-finish-load", async () => {
    const js = (source) => win.webContents.executeJavaScript(source);
    try {
      await until(() => js("!!window.arbor"), "preload bridge");
      if (!resumed) {
        await until(
          () => js("document.querySelector('#setup-dialog').open"),
          "first-launch wizard",
        );
        if (process.env.ARBOR_FLOW_SCREENSHOT) {
          await pause(150);
          fs.writeFileSync(
            `${process.env.ARBOR_FLOW_SCREENSHOT}.setup.png`,
            (await win.webContents.capturePage()).toPNG(),
          );
        }
        await pause(400);
        let state = await js("window.arbor.getState()");
        assert.equal(state.setupRequired, true);
        assert.equal(state.busy, false);
        assert.equal(state.report, null);
        assert.equal(fs.existsSync(calls), false, "first launch must not scan");
        assert.equal(
          await js("document.querySelector('#setup-github').checked"),
          false,
        );
        assert.equal(
          await js("document.querySelector('#setup-fetch').checked"),
          false,
        );
        await js(
          `document.querySelector('#setup-root').value=${JSON.stringify(root)}; document.querySelector('#setup-next').click()`,
        );
        await pause(100);
        if (process.env.ARBOR_FLOW_SCREENSHOT) {
          fs.writeFileSync(
            `${process.env.ARBOR_FLOW_SCREENSHOT}.options.png`,
            (await win.webContents.capturePage()).toPNG(),
          );
        }
        await js("document.querySelector('#setup-next').click()");
        await pause(100);
        await js("document.querySelector('#setup-start').click()");
      } else {
        const state = await js("window.arbor.getState()");
        assert.equal(state.setupRequired, false);
        assert.equal(
          await js("document.querySelector('#setup-dialog').open"),
          false,
        );
      }
      await until(
        () =>
          js(
            "window.arbor.getState().then(s=>s.busy && s.partialWorktrees?.length > 0)",
          ),
        "live worktrees before scan completion",
      );
      const partial = await js("window.arbor.getState()");
      assert.equal(partial.report, null);
      assert.equal(partial.revision, null);
      assert.equal(partial.partialWorktrees[0].canRemove, false);
      assert.equal(partial.partialWorktrees[0].recommended, false);
      assert.ok(partial.progress.startedAt > 0);
      await until(
        () =>
          js(
            "!document.querySelector('#scan-progress').hidden && document.querySelectorAll('#worktree-list tr').length > 0",
          ),
        "visible progress and live rows",
      );
      if (!resumed && process.env.ARBOR_FLOW_SCREENSHOT)
        fs.writeFileSync(
          `${process.env.ARBOR_FLOW_SCREENSHOT}.progress.png`,
          (await win.webContents.capturePage()).toPNG(),
        );
      assert.equal(
        await js("document.querySelector('#cleanup-button').disabled"),
        true,
      );
      await js("document.querySelector('#settings-button').click()");
      await until(
        () => js("document.querySelector('#settings-dialog').open"),
        "settings during scan",
      );
      assert.equal(
        await js("document.querySelector('#settings-save').disabled"),
        true,
      );
      assert.match(
        await js("document.querySelector('#settings-save').textContent"),
        /Scanning/,
      );
      await js("document.querySelector('#settings-dialog').close()");
      await until(
        () =>
          js(
            "window.arbor.getState().then(s=>!s.busy && s.report?.worktrees.length===3)",
          ),
        "finished report",
      );
      await until(
        () => js("document.querySelectorAll('#worktree-list tr').length===3"),
        "final rows",
      );
      const saved = JSON.parse(fs.readFileSync(preferences, "utf8"));
      assert.equal(saved.setupCompleted, true);
      assert.equal(saved.scan.root, root);
      assert.equal(saved.scan.github, false);
      assert.equal(saved.scan.fetch, false);
      assert.ok(saved.scan.excludes.includes(".cache"));
      assert.ok(saved.scan.excludes.includes("node_modules"));
      const invocations = fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(invocations.length, resumed ? 3 : 1);
      assert.ok(invocations.every((args) => args.includes("--progress")));
      assert.ok(
        invocations.every((args) => args.includes("--no-default-excludes")),
      );
      assert.ok(invocations.every((args) => args.includes(".cache")));
      assert.ok(
        invocations.every((args) => args[args.indexOf("--path") + 1] === root),
      );
      if (!resumed) {
        if (process.env.ARBOR_FLOW_SCREENSHOT) {
          const capture = await win.webContents.capturePage();
          fs.writeFileSync(process.env.ARBOR_FLOW_SCREENSHOT, capture.toPNG());
        }
        await js("document.querySelector('#refresh-button').click()");
        await until(
          () =>
            js(
              "window.arbor.getState().then(s=>s.busy && s.partialWorktrees?.length > 0)",
            ),
          "second scan live results",
        );
        await until(
          () =>
            js(
              "!document.querySelector('#stop-scan').hidden && !document.querySelector('#stop-scan').disabled",
            ),
          "stop scan control",
        );
        await js("document.querySelector('#settings-button').click()");
        assert.equal(
          await js("document.querySelector('#settings-stop-scan').hidden"),
          false,
        );
        await js("document.querySelector('#settings-stop-scan').click()");
        await until(
          () => js("window.arbor.getState().then(s=>!s.busy && s.cancelled)"),
          "scan cancellation",
        );
        const stopped = await js("window.arbor.getState()");
        assert.equal(stopped.report, null);
        assert.equal(stopped.revision, null);
        assert.ok(stopped.partialWorktrees.length > 0);
        await until(
          () => js("!document.querySelector('#settings-save').disabled"),
          "settings enabled after cancellation",
        );
        await js("document.querySelector('#settings-dialog').close()");
        await until(
          () =>
            js(
              "document.querySelector('#progress-stage').textContent.includes('stopped')",
            ),
          "stopped scan message",
        );
        assert.equal(
          await js("document.querySelector('#cleanup-button').disabled"),
          true,
        );
        assert.equal(
          await js(
            "[...document.querySelectorAll('[data-remove]')].every(button=>button.disabled)",
          ),
          true,
        );
        const child = spawn(
          process.execPath,
          [__filename, ...process.argv.filter((arg) => arg === "--no-sandbox")],
          {
            env: {
              ...process.env,
              ARBOR_FLOW_PHASE: "resume",
              ARBOR_FLOW_DIRECTORY: directory,
            },
            stdio: "inherit",
          },
        );
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code, 0, "configured restart flow");
      }
      console.log(
        `Desktop flow passed (${resumed ? "configured restart" : "first launch"}): wizard, live rows, progress, cleanup gating, preferences`,
      );
      clearTimeout(deadline);
      app.exit(0);
    } catch (error) {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    }
  });
});
require("../desktop/main.cjs");
