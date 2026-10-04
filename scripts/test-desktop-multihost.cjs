"use strict";

// Exercise real Electron/IPC/renderer coordination using synthetic, gated CLI
// processes. No SSH connection or real worktree operation is ever performed.
const { app, dialog } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(40);
  }
  throw new Error(`Timed out: ${label}`);
}

const fixture = process.env.ARBOR_MULTIHOST_FIXTURE;
const deadline = setTimeout(() => {
  console.error("Desktop multihost fixture timed out");
  app.exit(1);
}, 45000);
if (!fixture) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-multihost-"));
  const child = spawn(
    process.execPath,
    [__filename, ...process.argv.filter((arg) => arg === "--no-sandbox")],
    { env: { ...process.env, ARBOR_MULTIHOST_FIXTURE: directory }, stdio: "inherit" },
  );
  child.once("error", (error) => {
    console.error(error);
    app.exit(1);
  });
  child.once("close", (code) => {
    try {
      assert.equal(code, 0, "multihost Electron child exit");
      const result = JSON.parse(fs.readFileSync(path.join(directory, "result.json"), "utf8"));
      assert.ok(result.elapsed < 8000, `all-host quit took ${result.elapsed}ms`);
      assert.equal(result.activePids.length, 3, "quit exercised three simultaneous scans");
      for (const pid of result.activePids)
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "every host scan exits before Electron");
      assert.equal(fs.readFileSync(path.join(directory, "projects", "preserve-me"), "utf8"), "untouched");
      console.log("Desktop multihost passed: independent scans, live host filters, colliding paths, per-host Stop, scoped deletion/statistics, all-job shutdown");
      clearTimeout(deadline);
      app.exit(0);
    } catch (error) {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    }
  });
} else {
  if (!path.basename(fixture).startsWith("arbor-multihost-"))
    throw new Error("Expected isolated multi-host fixture");
  const root = path.join(fixture, "projects");
  const userData = path.join(fixture, "profile");
  const callsPath = path.join(fixture, "calls.jsonl");
  const binary = path.join(fixture, "fixture-cli");
  const alpha = "fixture-alpha", beta = "fixture-beta";
  const sourceKey = (host) => host || "local";
  const gate = (host, mode) => fs.writeFileSync(path.join(fixture, sourceKey(host) + ".gate"), mode);
  fs.mkdirSync(root);
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(root, "preserve-me"), "untouched");
  gate("", "release");
  gate(alpha, "hold");
  gate(beta, "hold");
  fs.writeFileSync(path.join(userData, "preferences.json"), JSON.stringify({
    setupCompleted: true,
    theme: "light",
    roots: [root],
    hosts: [alpha, beta].map((host) => ({ name: host, host, root })),
    scan: { root, host: "", github: false, fetch: false, excludes: [] },
  }));
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const host = args.includes('--host') ? args[args.indexOf('--host')+1] : '';
const directory = ${JSON.stringify(fixture)};
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,host,pid:process.pid})+'\\n');
const root = ${JSON.stringify(root)};
if(args[0]==='remove') { process.stdout.write(JSON.stringify({path:args.at(-1),removed:true})); process.exit(0); }
if(args[0]==='stats') {
  process.stdout.write(JSON.stringify({version:1,removedWorktrees:host===${JSON.stringify(alpha)}?45:host?7:12,estimatedBytesReclaimed:1048576,missingRegistrations:0,cleanupSessions:1,largestWorktreeBytes:1048576,detachedCommitsRetained:0,firstCleanupAt:'2026-09-30T12:00:00Z',lastCleanupAt:'2026-09-30T12:00:00Z',daily:[{date:'2026-09-30',removedWorktrees:1,estimatedBytesReclaimed:1048576}]})); process.exit(0);
}
if(args[0]!=='list') { console.error('unexpected fixture command'); process.exit(1); }
// A failed Electron assertion must not leave its gated fake scans alive.
setTimeout(()=>process.exit(70),40000).unref();
// Identical native IDs and paths on every host exercise provenance isolation.
const worktrees=[0,1].map(i=>({id:'same-'+i,path:root+'/sessions/same-'+i,repo:'fixture',branch:'topic-'+i,head:'a'.repeat(40),commonDir:root+'/repo/.git',canRemove:true,canDiscard:true,recommended:true,sizeBytes:1024,activityAt:'2026-09-30T12:00:00Z',blockers:[],problems:[],publishedRefs:[],discardWarnings:[]}));
process.on('SIGTERM',()=>{fs.writeFileSync(directory+'/'+process.pid+'.stopped','yes');process.exit(0);});
process.stderr.write('@arbor-progress '+JSON.stringify({stage:'inspect',path:root,discovered:2,completed:0,total:2})+'\\n');
const timer=setInterval(()=>{
  if(fs.readFileSync(directory+'/'+(host||'local')+'.gate','utf8')!=='release') return;
  clearInterval(timer);
  process.stdout.write(JSON.stringify({root,worktrees,warnings:[],scannedAt:new Date().toISOString(),durationMs:10}));
},40);
`, { mode: 0o700 });
  const calls = () => fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const listCalls = () => calls().filter((call) => call.args[0] === "list");
  const confirmations = [];
  dialog.showMessageBox = async (_window, options) => {
    confirmations.push(options);
    return { response: 1 };
  };
  app.setPath("userData", userData);
  process.env.ARBOR_CLI_PATH = binary;
  delete process.env.ARBOR_SMOKE_TEST;
  let closingAt, activePids;
  app.on("will-quit", () => {
    if (closingAt)
      fs.writeFileSync(path.join(fixture, "result.json"), JSON.stringify({elapsed:Date.now()-closingAt,activePids}));
  });
  app.once("browser-window-created", (_event, win) => {
    if (process.env.ARBOR_MULTIHOST_SCREENSHOT) win.setSize(1260, 1000);
    win.webContents.once("did-finish-load", async () => {
      const js = (source) => win.webContents.executeJavaScript(source);
      const state = () => js("window.arbor.getState()");
      const hostState = async (host) => (await state()).hosts?.find((entry) => entry.host === host);
      const switchHost = async (host) => {
        // Main-process results can arrive before the renderer's remove promise
        // settles. A real user cannot activate a still-disabled machine picker.
        await until(() => js("typeof document.querySelector('#machine-button').onclick === 'function' && !document.querySelector('#machine-button').disabled"), "enabled machine picker after prior operation");
        await js("document.querySelector('#machine-button').click()");
        await until(() => js("document.querySelector('#machine-dialog').open"), "machine picker");
        const selector = host === null ? "[data-all-hosts]" : `.machine-option[data-host=${JSON.stringify(host)}]`;
        await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await until(async () => (await state()).hostFilter === host, `filter ${host ?? "all"}`);
        // All hosts and every remote share the server icon. Wait for the exact
        // rendered scope, not only the earlier backend filter change.
        const label = host === null ? "All hosts" : host || "This computer";
        await until(() => js(`!document.querySelector('#machine-dialog').open && document.querySelector('#machine-label').textContent === ${JSON.stringify(label)}`), `rendered scope ${label}`);
        await until(() => js(`document.querySelector('#machine-icon')?.dataset.kind === ${JSON.stringify(host === "" ? "monitor" : "server")}`), "host icon matches selected scope");
      };
      try {
        await until(async () => {
          const local = await hostState("");
          return local?.report && local.worktreeCount === 2 && !local.busy && (await hostState(alpha))?.busy && (await hostState(beta))?.busy;
        }, "local completion with two remote scans running");
        assert.equal((await state()).hostFilter, null, "normal startup shows all hosts");
        assert.equal(listCalls().length, 3, "each saved host starts independently once");
        const initialPids = listCalls().map((call) => call.pid);
        await switchHost("");
        await until(() => js("document.querySelectorAll('#worktree-list tr[data-id]').length === 2"), "local rows remain available");
        assert.equal(await js("document.querySelector('[data-delete]').disabled"), false, "background remote scan does not disable local cleanup");
        await switchHost(alpha);
        await switchHost(null);
        assert.deepEqual(listCalls().map((call) => call.pid), initialPids, "filter changes do not restart or cancel scans");
        gate(alpha, "release");
        await until(async () => {
          const source = await hostState(alpha);
          return !source?.busy && source?.report && source.worktreeCount === 2;
        }, "alpha completion");
        assert.equal((await hostState(beta)).busy, true);
        await until(() => js("document.querySelectorAll('tr.host-row[data-host]').length >= 2"), "all-host headings");
        const combined = (await state()).report.worktrees;
        const twins = combined.filter((row) => row.path === root + "/sessions/same-0");
        assert.equal(twins.length, 2, "identical paths from two hosts remain visible");
        assert.equal(new Set(twins.map((row) => row.id)).size, 2, "row identity includes host");
        assert.deepEqual(new Set(twins.map((row) => row.host)), new Set(["", alpha]));
        gate(alpha, "hold");
        await js(`window.arbor.refreshHosts(${JSON.stringify(alpha)})`);
        await until(async () => (await hostState(alpha))?.busy && listCalls().length === 4, "alpha background refresh");
        await until(() => js(`!!document.querySelector('[data-stop-host="${alpha}"]')`), "per-host stop control");
        if (process.env.ARBOR_MULTIHOST_SCREENSHOT) {
          // The backend refresh was invoked directly above; let the renderer's
          // next polling snapshot and paint catch up before capturing its UI.
          await pause(650);
          await until(() => js(`document.querySelector('#progress-stage').textContent.includes('Scanning 2') && !!document.querySelector('[data-stop-host="${alpha}"]') && !!document.querySelector('[data-stop-host="${beta}"]')`), "both remote scans painted for screenshot");
          await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          fs.writeFileSync(process.env.ARBOR_MULTIHOST_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
        }
        await js(`document.querySelector('[data-stop-host="${alpha}"]').click()`);
        await until(async () => !(await hostState(alpha))?.busy, "alpha stopped");
        assert.ok((await hostState(alpha)).report, "stopping refresh preserves completed report metadata");
        assert.equal((await hostState(alpha)).worktreeCount, 2, "stopping refresh preserves completed cached rows");
        assert.equal((await hostState(beta)).busy, true, "stopping alpha does not stop beta");
        await switchHost(alpha);
        await until(() => js("document.querySelectorAll('#worktree-list tr[data-id]').length === 2"), "cached alpha rows");
        await js("document.querySelector('[data-delete]').click()");
        await until(() => calls().filter((call) => call.args[0] === "remove").length === 1, "scoped remote deletion");
        await until(async () => (await hostState(alpha)).worktreeCount === 1, "incremental alpha removal");
        assert.equal(confirmations.length, 1, "one native delete confirmation");
        const removal = calls().find((call) => call.args[0] === "remove");
        assert.equal(removal.host, alpha, "delete routes to the row's host");
        assert.equal(removal.args[removal.args.indexOf("--id") + 1], "same-0", "remote CLI receives native ID, not merged UI ID");
        assert.equal(listCalls().length, 4, "successful cleanup does not rescan");
        assert.equal((await hostState("")).worktreeCount, 2, "colliding local row was not removed");
        for (const [host, expected] of [[alpha, "45"], ["", "12"]]) {
          await switchHost(host);
          await js("document.querySelector('#statistics-button').click()");
          await until(() => js(`document.querySelector('#statistics-dialog').open && document.querySelector('[data-stat="removedWorktrees"]')?.textContent === ${JSON.stringify(expected)}`), `source-specific statistics for ${host || "local"}`);
          assert.equal(calls().filter((call) => call.args[0] === "stats").at(-1).host, host);
          await js(`new Promise(resolve => {
            const dialog = document.querySelector('#statistics-dialog');
            dialog.addEventListener('close', resolve, {once: true});
            dialog.close();
          })`);
        }
        assert.equal(listCalls().length, 4, "statistics/filter changes perform no scans");
        await switchHost(null);
        gate("", "hold");
        await js("window.arbor.refreshHosts(null)");
        await until(async () => (await state()).hosts.every((entry) => entry.busy) && listCalls().length === 6, "three active jobs before quitting");
        activePids = ["", alpha, beta].map((host) => listCalls().filter((call) => call.host === host).at(-1).pid);
        closingAt = Date.now();
        clearTimeout(deadline);
        app.quit();
      } catch (error) {
        console.error(error);
        try {
          console.error("Multi-host failure details:", {
            statsHosts: calls().filter((call) => call.args[0] === "stats").map((call) => call.host),
            renderer: await js(`(() => ({
              machine: document.querySelector('#machine-label').textContent,
              machineDisabled: document.querySelector('#machine-button').disabled,
              machineDialogOpen: document.querySelector('#machine-dialog').open,
              statisticsOpen: document.querySelector('#statistics-dialog').open,
              statisticsContent: document.querySelector('#statistics-content').textContent.slice(0, 1000)
            }))()`),
          });
          await js("window.arbor.cancelScan(null)");
          await until(async () => (await state()).hosts.every((host) => !host.busy), "fixture scans stopped after failure");
        } catch (cleanupError) {
          console.error("Fixture shutdown:", cleanupError.message);
        }
        clearTimeout(deadline);
        app.exit(1);
      }
    });
  });
  require("../desktop/main.cjs");
}
