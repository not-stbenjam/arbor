"use strict";

// Real Electron UI/IPC with synthetic CLI data and an isolated profile. This
// never contacts SSH hosts or scans/deletes real repositories.
const { app, dialog } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(50);
  }
  throw new Error(`Timed out: ${label}`);
}

const phase = process.env.ARBOR_WORKSPACES_PHASE;
const deadline = setTimeout(() => {
  console.error("Desktop workspace fixture timed out");
  app.exit(1);
}, 45000);
if (!phase) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-workspaces-"));
  (async () => {
    for (const current of ["initial", "restart"]) {
      const child = spawn(
        process.execPath,
        [__filename, ...process.argv.filter((arg) => arg === "--no-sandbox")],
        {
          env: {
            ...process.env,
            ARBOR_WORKSPACES_PHASE: current,
            ARBOR_WORKSPACES_DIRECTORY: directory,
          },
          stdio: "inherit",
        },
      );
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, `${current} workspace fixture exit`);
    }
    console.log(
      "Desktop workspaces passed: cached machine switching, deletion, statistics, Delete colors, bounded confirmation, persisted restart",
    );
    clearTimeout(deadline);
    app.exit(0);
  })().catch((error) => {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  });
} else {
  const directory = process.env.ARBOR_WORKSPACES_DIRECTORY;
  if (!directory || !path.basename(directory).startsWith("arbor-workspaces-"))
    throw new Error("Expected isolated workspace fixture");
  const root = path.join(directory, "projects");
  const remoteRoot = "/fixture/vps/projects";
  const host = "fixture-vps";
  const userData = path.join(directory, "user-data");
  const callsPath = path.join(directory, "calls.jsonl");
  const binary = path.join(directory, "fixture-cli");
  if (phase === "initial") {
    fs.mkdirSync(root);
    fs.mkdirSync(userData);
    fs.writeFileSync(path.join(root, "preserve-me"), "untouched");
    fs.writeFileSync(
      path.join(userData, "preferences.json"),
      JSON.stringify({
        setupCompleted: true,
        theme: "light",
        roots: [root],
        hosts: [{ name: "Fixture VPS", host, root: remoteRoot }],
        scan: { root, host: "", github: false, fetch: false, excludes: [] },
      }),
    );
    fs.writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args)+'\\n');
const host = args.includes('--host') ? args[args.indexOf('--host')+1] : '';
if (args[0] === 'stats') {
  const daily=Array.from({length:30},(_,i)=>({date:new Date(Date.now()-(29-i)*86400000).toISOString().slice(0,10),removedWorktrees:i%4,estimatedBytesReclaimed:(i%4)*1048576}));
  process.stdout.write(JSON.stringify({version:1,removedWorktrees:host?45:12,estimatedBytesReclaimed:47185920,missingRegistrations:2,cleanupSessions:8,largestWorktreeBytes:8388608,detachedCommitsRetained:3,firstCleanupAt:'2026-09-01T12:00:00Z',lastCleanupAt:'2026-09-30T12:00:00Z',daily})); process.exit(0);
}
if (args[0] === 'remove') { process.stdout.write(JSON.stringify({path:args[args.length-1],removed:true})); process.exit(0); }
if (args[0] !== 'list') { console.error('unexpected fixture invocation'); process.exit(1); }
const root=args[args.indexOf('--path')+1];
const prefix=host?'remote':'local';
const worktrees=Array.from({length:12},(_,i)=>({id:prefix+'-'+i,path:root+'/sessions/'+prefix+'-'+i,repo:'fixture',branch:'topic-'+i,head:'a'.repeat(40),commonDir:root+'/repo/.git',sizeBytes:1048576,activityAt:'2026-09-30T12:00:00Z',blockers:[],problems:[],discardWarnings:[],publishedRefs:[],canRemove:true,canDiscard:true,recommended:true}));
setTimeout(()=>process.stdout.write(JSON.stringify({root,worktrees,warnings:[],scannedAt:new Date().toISOString(),durationMs:100})),100);
`,
      { mode: 0o700 },
    );
  }
  const calls = () =>
    fs.existsSync(callsPath)
      ? fs
          .readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse)
      : [];
  const listCount = () => calls().filter((args) => args[0] === "list").length;
  const responses = [];
  const prompts = [];
  dialog.showMessageBox = async (_window, options) => {
    assert.ok(
      responses.length,
      `unexpected native confirmation ${JSON.stringify(options)}`,
    );
    prompts.push(options);
    return { response: responses.shift() };
  };
  app.setPath("userData", userData);
  process.env.ARBOR_CLI_PATH = binary;
  delete process.env.ARBOR_SMOKE_TEST;
  app.once("browser-window-created", (_event, win) => {
    win.setSize(1050, 700);
    win.webContents.once("did-finish-load", async () => {
      const js = (source) => win.webContents.executeJavaScript(source);
      const state = () => js("window.arbor.getState()");
      const ready = (selectedHost, count) =>
        until(
          async () => {
            const current = await state();
            return (
              !current.busy &&
              current.hostFilter === selectedHost &&
              current.report?.worktrees.length === count &&
              (await js(
                `document.querySelectorAll('#worktree-list tr[data-id]').length===${count}`,
              ))
            );
          },
          `${selectedHost || "local"} report with ${count} rows`,
        );
      const switchMachine = async (selectedHost, count) => {
        await until(
          () => js("typeof document.querySelector('#machine-button').onclick === 'function' && !document.querySelector('#machine-button').disabled"),
          "initialized machine control",
        );
        await js("document.querySelector('#machine-button').click()");
        await until(
          () => js("document.querySelector('#host-menu').matches(':popover-open')"),
          "machine picker",
        );
        await js(
          `document.querySelector('.machine-option[data-host="${selectedHost}"]').click()`,
        );
        await ready(selectedHost, count);
      };
      try {
        await until(() => js("!!window.arbor"), "preload bridge");
        if (phase === "restart") {
          await switchMachine(host, 11);
          assert.equal(
            listCount(),
            2,
            "restart must restore the persisted active workspace without scanning",
          );
          assert.equal(
            (await state()).report.worktrees.some((w) => w.sourceID === "remote-0"),
            false,
          );
          await switchMachine("", 12);
          await switchMachine(host, 11);
          assert.equal(listCount(), 2, "both machine caches survive restart");
        } else {
          await switchMachine("", 12);
          assert.equal(listCount(), 2, "startup scans both configured hosts in the background");
          for (const theme of ["light", "dark"]) {
            const colors = await js(
              `(() => {document.documentElement.dataset.theme=${JSON.stringify(theme)}; const button=document.querySelector('[data-delete]');const style=getComputedStyle(button);return {selected:button.closest('tr').classList.contains('selected'),background:style.backgroundColor,border:style.borderTopColor,borderWidth:style.borderTopWidth,color:style.color,surface:getComputedStyle(document.body).backgroundColor};})()`,
            );
            assert.equal(colors.selected, false);
            assert.notEqual(
              colors.background,
              "rgba(0, 0, 0, 0)",
              `${theme}: Delete has visible background before selection`,
            );
            assert.notEqual(
              colors.background,
              colors.surface,
              `${theme}: Delete is distinct from its surface`,
            );
            assert.notEqual(
              colors.borderWidth,
              "0px",
              `${theme}: Delete has a border`,
            );
            assert.notEqual(
              colors.border,
              colors.background,
              `${theme}: Delete border is distinct`,
            );
            for (const width of [850, 1250]) {
              win.setSize(width, 700);
              await until(
                () => js(`innerWidth === ${width}`),
                "resized workspace",
              );
              const actions = await js(`(() => {
                const bounds = (element) => {
                  const {left, right, width, height} = element.getBoundingClientRect();
                  return {left, right, width, height};
                };
                return [...document.querySelectorAll('[data-delete], [data-folder-delete]')].map(button => ({
                  folder: button.hasAttribute('data-folder-delete'),
                  button: bounds(button),
                  menu: button.parentElement.querySelector('.row-menu') ? bounds(button.parentElement.querySelector('.row-menu')) : null,
                  cell: bounds(button.closest('td')),
                }));
              })()`);
              assert.ok(actions.some((action) => action.folder));
              assert.ok(actions.some((action) => !action.folder));
              const reference = actions[0].button;
              for (const action of actions) {
                for (const edge of ["left", "right", "width", "height"])
                  assert.ok(
                    Math.abs(action.button[edge] - reference[edge]) < 1,
                    `${theme}/${width}: all Delete buttons share ${edge}`,
                  );
                assert.ok(
                  action.button.left >= action.cell.left &&
                    action.button.right <= action.cell.right,
                  `${theme}/${width}: Delete stays inside its action cell`,
                );
                if (action.menu)
                  assert.ok(
                    action.menu.left > action.button.right &&
                      action.menu.right <= action.cell.right,
                    `${theme}/${width}: menu has its own non-overlapping column`,
                  );
              }
            }
          }
          win.setSize(1050, 700);
          await switchMachine(host, 12);
          assert.equal(listCount(), 2, "first remote visit reuses its background scan");
          await switchMachine("", 12);
          await switchMachine(host, 12);
          assert.equal(
            listCount(),
            2,
            "machine switching must restore cached reports",
          );
          responses.push(1);
          await js(`(async () => {
            const state = await window.arbor.getState();
            const row = state.report.worktrees.find(w => w.sourceID === 'remote-0');
            document.querySelector('[data-delete="' + CSS.escape(row.id) + '"]').click();
          })()`);
          await ready(host, 11);
          assert.equal(
            calls().filter((args) => args[0] === "remove").length,
            1,
          );
          await switchMachine("", 12);
          await switchMachine(host, 11);
          assert.equal(
            listCount(),
            2,
            "cached deletion does not rescan or resurrect the removed row",
          );
          // Several at once are shown in the window's own review, every
          // one of them, which a native dialog has no room to do.
          await js("document.querySelector('[data-folder-delete]').click()");
          await until(
            () => js("document.querySelector('#cleanup-dialog').open"),
            "the review of the folder's worktrees",
          );
          assert.equal(
            await js("document.querySelectorAll('#cleanup-list .cleanup-item').length"),
            11,
          );
          assert.match(
            await js("document.querySelector('#cleanup-title').textContent"),
            /these 11 worktrees/,
          );
          assert.equal(prompts.length, 1, "nothing is asked natively for a review");
          await js("document.querySelector('#cleanup-cancel').click()");
          await until(
            async () => !(await state()).busy,
            "cancelled group deletion",
          );
          assert.equal(
            calls().filter((args) => args[0] === "remove").length,
            1,
          );
          await js("document.querySelector('#statistics-button').click()");
          await until(
            () =>
              js(
                "document.querySelector('#statistics-dialog').open && !!document.querySelector('.statistics-chart')",
              ),
            "statistics dialog and chart",
          );
          const geometry = await js(
            "(() => {const d=document.querySelector('#statistics-dialog'),b=document.querySelector('#statistics-button'),s=document.querySelector('#settings-button');return {height:d.getBoundingClientRect().height,viewport:innerHeight,maxHeight:getComputedStyle(d).maxHeight,buttonY:b.getBoundingClientRect().y,settingsY:s.getBoundingClientRect().y,text:d.textContent};})()",
          );
          assert.ok(
            geometry.height <= geometry.viewport - 20,
            "statistics stays within the window",
          );
          assert.notEqual(geometry.maxHeight, "none");
          assert.ok(
            Math.abs(geometry.buttonY - geometry.settingsY) < 150,
            "Statistics is near Settings",
          );
          assert.equal(
            await js(
              "document.querySelector('[data-stat=\"removedWorktrees\"]').textContent",
            ),
            "45",
            "remote worktree count must be exact, not matched by the recovered byte total",
          );
          assert.equal(
            await js(
              "document.querySelector('[data-stat=\"estimatedBytesReclaimed\"]').textContent",
            ),
            "45 MB",
            "recovered space is shown in its own statistic",
          );
          const statsCalls = calls().filter((args) => args[0] === "stats");
          assert.ok(statsCalls.length > 0);
          assert.ok(
            statsCalls.every(
              (args) => args[args.indexOf("--host") + 1] === host,
            ),
            "statistics uses selected SSH machine",
          );
          assert.equal(listCount(), 2, "opening Statistics must not scan");
          if (process.env.ARBOR_WORKSPACE_SCREENSHOT) {
            fs.writeFileSync(
              process.env.ARBOR_WORKSPACE_SCREENSHOT,
              (await win.webContents.capturePage()).toPNG(),
            );
          }
          await js("document.querySelector('#statistics-dialog').close()");
          await pause(400);
        }
        assert.equal(
          fs.readFileSync(path.join(root, "preserve-me"), "utf8"),
          "untouched",
        );
        console.log(`Desktop workspace phase passed: ${phase}`);
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
}
