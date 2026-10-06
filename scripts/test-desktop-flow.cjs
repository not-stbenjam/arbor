"use strict";

// Run with Electron under a desktop session (or xvfb-run). All preferences and
// scan data are isolated fixtures; this never scans or removes user worktrees.
const { app, dialog, Menu, clipboard } = require("electron");
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
const glob = "~/.codex*/.tmp";
const resetResponses = [];
const removalResponses = [];
const removalDialogs = [];
let lastMenu;
Menu.prototype.popup = function () {
  lastMenu = this;
};
let resetDialogs = 0;
// Stub only the OS confirmation UI, exercising the real IPC/reset implementation.
dialog.showMessageBox = async (_window, options) => {
  if (options.title !== "Reset Arbor?") {
    assert.ok(
      removalResponses.length,
      `unexpected native dialog: ${JSON.stringify(options)}`,
    );
    removalDialogs.push(options);
    return { response: removalResponses.shift() };
  }
  assert.equal(options.title, "Reset Arbor?");
  assert.equal(options.message, "Reset Arbor to its defaults?");
  assert.deepEqual(options.buttons, ["Cancel", "Reset Arbor"]);
  assert.equal(options.defaultId, 0);
  assert.ok(resetResponses.length, "unexpected native confirmation");
  resetDialogs++;
  return { response: resetResponses.shift() };
};
if (!resumed) {
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "preserve-me"), "untouched");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if (args[0] === 'remove') { process.stdout.write(JSON.stringify({path:args[args.length-1],removed:true})); process.exit(0); }
const root = args[args.indexOf('--path')+1];
const trees = Array.from({length:40}, (_,i)=>({id:'tree-'+i,path:root+'/sessions/'+(i<20?'old':'recent')+'/tree-'+i,repo:'fixture-'+i,branch:'topic-'+i,head:'a'.repeat(40),commonDir:root+'/repo-'+i+'/.git',blockers:i===1?['Ignored files on disk (may include local secrets or build output)']:[],discardWarnings:i===1?['Ignored files will be deleted.']:[],ignored:i===1,problems:[],publishedRefs:[],canRemove:i!==1,canDiscard:true,recommended:i!==1}));
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
    // Deleting several at once first shows every one of them; agreeing
    // there is what goes on to the deletion, or to the question about
    // anything that would be discarded.
    const agreeToReview = async () => {
      await until(
        () => js("document.querySelector('#cleanup-dialog').open"),
        "the review of what would be deleted",
      );
      await js("document.querySelector('#cleanup-confirm').click()");
    };
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
        await js(
          `document.querySelector('#setup-excludes').value += '\\n' + ${JSON.stringify(glob)}`,
        );
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
            "window.arbor.getState().then(s=>s.busy && s.report?.worktrees.some(row=>row.pending))",
          ),
        "live worktrees before scan completion",
      );
      const partial = await js("window.arbor.getState()");
      const partialSource = partial.hosts.find((host) => host.host === "");
      assert.equal(partialSource.report, null);
      assert.equal(partialSource.revision, null);
      assert.ok(partial.report.worktrees.length > 0);
      assert.ok(partial.report.worktrees.every((row) => row.pending && !row.canRemove && !row.canDiscard && !row.recommended && row.nativeRevision === null));
      assert.ok(partialSource.progress.startedAt > 0);
      await until(
        () =>
          js(
            "!document.querySelector('#scan-progress').hidden && document.querySelectorAll('#worktree-list tr[data-id]').length > 0",
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
            "window.arbor.getState().then(s=>!s.busy && s.report?.worktrees.length===40)",
          ),
        "finished report",
      );
      await until(
        () =>
          js(
            "document.querySelectorAll('#worktree-list tr[data-id]').length===40",
          ),
        "final rows",
      );
      const saved = JSON.parse(fs.readFileSync(preferences, "utf8"));
      assert.equal(saved.setupCompleted, true);
      assert.equal(saved.scan.root, root);
      assert.equal(saved.scan.github, false);
      assert.equal(saved.scan.fetch, false);
      assert.ok(saved.scan.excludes.includes(".cache"));
      assert.ok(saved.scan.excludes.includes("node_modules"));
      assert.ok(saved.scan.excludes.includes("~/.codex/.tmp"));
      assert.ok(saved.scan.excludes.includes(glob));
      const invocations = fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .filter((args) => args[0] === "list");
      assert.equal(invocations.length, resumed ? 3 : 1);
      assert.ok(invocations.every((args) => args.includes("--progress")));
      assert.ok(invocations.every((args) => args.includes("--linked-only")));
      assert.ok(
        invocations.every((args) => args.includes("--no-default-excludes")),
      );
      assert.ok(invocations.every((args) => args.includes(".cache")));
      assert.ok(invocations.every((args) => args.includes(glob)));
      assert.ok(
        invocations.every((args) => args[args.indexOf("--path") + 1] === root),
      );
      if (resumed) {
        // The restarted app agrees to the review. Every worktree it listed
        // is deleted as a recommendation, with no other question asked, and
        // the one that is not a recommendation is left.
        const removals = () =>
          fs
            .readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse)
            .filter((args) => args[0] === "remove");
        const before = removals().length;
        await js("document.querySelector('#cleanup-button').click()");
        await until(
          () => js("document.querySelector('#cleanup-dialog').open"),
          "the review opens",
        );
        assert.equal(
          await js("document.querySelectorAll('#cleanup-list .cleanup-item').length"),
          39,
        );
        const confirm = await js(
          `(() => { const r = document.querySelector('#cleanup-confirm').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
        );
        for (const type of ["mouseDown", "mouseUp"])
          win.webContents.sendInputEvent({
            type,
            ...confirm,
            button: "left",
            clickCount: 1,
          });
        await until(
          () => js("!document.querySelector('#cleanup-dialog').open"),
          "agreeing closes the review",
        );
        await until(
          () =>
            js(
              "window.arbor.getState().then(s=>!s.busy && s.report?.worktrees.length===1)",
            ),
          "the recommended worktrees are deleted",
        );
        // The button that opened the review is disabled while it deletes, so
        // the keyboard is in the list, not nowhere.
        assert.equal(
          await js("document.activeElement?.id"),
          "worktree-grid",
        );
        const made = removals().slice(before);
        assert.equal(made.length, 39);
        assert.ok(made.every((args) => args.includes("--recommended-only")));
        assert.ok(made.every((args) => args.includes("--keep-local")));
        assert.ok(made.every((args) => !args.at(-1).endsWith("/tree-1")));
        assert.equal(removalDialogs.length, 0, "no second question is asked");
      }
      if (!resumed) {
        const completed = await js("window.arbor.getState()");
        const tree1ID = completed.report.worktrees.find((row) => row.sourceID === "tree-1").id;
        assert.equal(await js("document.querySelector('#inspector')"), null);
        assert.equal(
          await js("document.querySelector('[data-view=protected]')"),
          null,
        );
        assert.ok(
          await js(
            "document.querySelectorAll('tr[data-directory-path]').length >= 4",
          ),
        );
        // A row is named by its last component, under the folders that hold
        // it; the whole path stays one hover or Copy path away.
        assert.deepEqual(
          await js(
            `(() => { const path = document.querySelector('tr[data-id="${tree1ID}"] .worktree-path'); return [path.textContent.trim(), path.title]; })()`,
          ),
          ["tree-1", root + "/sessions/old/tree-1"],
        );
        // A row is ticked by clicking it or the box at its left. One tick is
        // enough to offer the bulk action; ticking another row unticks
        // nothing; a folder's box ticks what is shown under it; Escape clears.
        // "all" is the heading's box, and how many boxes anywhere show a dash:
        // a box over some ticked rows stays empty, so that is never any.
        const status = () =>
          js("document.querySelector('#status-message').textContent");
        const summary = await status();
        const ticked = () =>
          js(
            `({ boxes: [...document.querySelectorAll('[data-select]')].filter((box) => box.checked).length, rows: document.querySelectorAll('.worktree-row.selected').length, bar: document.querySelector('#selection-bar').hidden ? '' : document.querySelector('#selection-label').textContent, all: [document.querySelector('#select-all').checked, [...document.querySelectorAll('#worktree-grid input[type=checkbox]')].filter((box) => box.indeterminate).length] })`,
          );
        assert.deepEqual(await ticked(), {
          boxes: 0,
          rows: 0,
          bar: "",
          all: [false, 0],
        });
        await js(
          `document.querySelector('tr[data-id="${tree1ID}"] [data-select]').click()`,
        );
        // tree-1 holds ignored files, and the bar says so before any dialog.
        assert.deepEqual(await ticked(), {
          boxes: 1,
          rows: 1,
          bar: "1 worktree selected · 1 would lose files",
          all: [false, 0],
        });
        assert.equal(await status(), summary, "the totals stay where they are");
        // The whole row is its box. Real clicks on three other rows' names:
        // the first ticks its row and leaves tree-1 ticked, Shift on the third
        // ticks the rows between without selecting their text, and a click on
        // a ticked row unticks that row only.
        const names = await js(
          `[...document.querySelectorAll('tr[data-id]:not([data-id="${tree1ID}"]) .path-leaf')].slice(0, 3).map((leaf) => { const r = leaf.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: Math.round(r.left) + 2, right: Math.round(r.right) - 2 }; })`,
        );
        const mouseAt = (type, x, y, modifiers = []) =>
          win.webContents.sendInputEvent({
            type,
            x,
            y,
            button: "left",
            clickCount: 1,
            modifiers,
          });
        const point = (at, modifiers = []) => {
          for (const type of ["mouseDown", "mouseUp"])
            mouseAt(type, at.x, at.y, modifiers);
        };
        const boxes = (count, message) =>
          until(async () => (await ticked()).boxes === count, message);
        point(names[0]);
        await boxes(2, "a click on a row ticks it");
        point(names[2], ["shift"]);
        await boxes(4, "Shift with a click ticks the range");
        assert.equal(
          await js("getSelection().toString()"),
          "",
          "a range of rows is not a selection of text",
        );
        point(names[1]);
        await boxes(3, "a click on a ticked row unticks it");
        point(names[0]);
        point(names[2]);
        await boxes(1, "each click unticks its own row");
        // Dragging across a name selects its text, to copy, and ticks nothing.
        mouseAt("mouseDown", names[1].left, names[1].y);
        mouseAt("mouseMove", names[1].right, names[1].y, ["leftButtonDown"]);
        mouseAt("mouseUp", names[1].right, names[1].y);
        await until(
          async () => (await js("getSelection().toString()")) !== "",
          "a drag across a name selects its text",
        );
        assert.equal((await ticked()).boxes, 1, "selecting text ticks nothing");
        await js("getSelection().removeAllRanges()");
        // Shift on a row's own box takes the range and selects no text either.
        const box = await js(
          `(() => { const r = [...document.querySelectorAll('tr[data-id]:not([data-id="${tree1ID}"]) [data-select]')][2].getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
        );
        point(names[0]);
        await boxes(2, "ticked again");
        point(box, ["shift"]);
        await boxes(4, "Shift on a box ticks the range");
        assert.equal(await js("getSelection().toString()"), "");
        point(names[0]);
        point(names[1]);
        point(names[2]);
        await boxes(1, "back to the one tick");
        // Going to a row with the keyboard ticks nothing and unticks nothing.
        await js(
          "document.querySelector('#worktree-grid').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))",
        );
        assert.equal((await ticked()).boxes, 1);
        await js(
          `document.querySelector('tr[data-directory-path="${root}/sessions/old"] [data-select-folder]').click()`,
        );
        const folder = await ticked();
        assert.deepEqual(
          { ...folder, bar: folder.bar.replace(/ · \d+ would lose files$/, "") },
          {
            boxes: 20,
            rows: 20,
            bar: "20 worktrees selected",
            all: [false, 0],
          },
        );
        assert.match(folder.bar, / · \d+ would lose files$/);
        // The folder's own box is ticked now that everything under it is.
        assert.equal(
          await js(
            `document.querySelector('tr[data-directory-path="${root}/sessions/old"] [data-select-folder]').checked`,
          ),
          true,
        );
        await js("document.querySelector('#select-all').click()");
        assert.deepEqual((await ticked()).all, [true, 0]);
        await js(
          "document.querySelector('#worktree-grid').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
        );
        assert.deepEqual(await ticked(), {
          boxes: 0,
          rows: 0,
          bar: "",
          all: [false, 0],
        });
        const oldFolder = root + "/sessions/old";
        const oldFolderKey = JSON.stringify(["", oldFolder]);
        await js(
          `document.querySelector('[data-toggle-directory="' + CSS.escape(${JSON.stringify(oldFolderKey)}) + '"]').click()`,
        );
        assert.equal(
          await js(
            "document.querySelectorAll('#worktree-list tr[data-id]').length",
          ),
          20,
        );
        await js(
          `document.querySelector('[data-toggle-directory="' + CSS.escape(${JSON.stringify(oldFolderKey)}) + '"]').click()`,
        );
        assert.equal(
          await js(
            "document.querySelectorAll('#worktree-list tr[data-id]').length",
          ),
          40,
        );
        await js(
          `document.querySelector('tr[data-id="${tree1ID}"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true}))`,
        );
        await until(() => lastMenu, "native row menu");
        assert.ok(
          lastMenu.items.some((item) =>
            /^Open in terminal/i.test(item.label),
          ),
        );
        lastMenu.items.find((item) => item.label === "Copy path").click();
        await until(
          async () => (await clipboard.readText()) === oldFolder + "/tree-1",
          "copy path from native menu",
        );
        // A folder action must use the displayed filter, even when matching
        // children are collapsed. Hidden siblings must never enter confirmation.
        await js(
          `document.querySelector('#search').value='topic-1'; document.querySelector('#search').dispatchEvent(new Event('input'))`,
        );
        assert.equal(
          await js(
            "document.querySelectorAll('#worktree-list tr[data-id]').length",
          ),
          11,
        );
        await js(
          `document.querySelector('[data-toggle-directory="' + CSS.escape(${JSON.stringify(oldFolderKey)}) + '"]').click()`,
        );
        assert.equal(
          await js(
            "document.querySelectorAll('#worktree-list tr[data-id]').length",
          ),
          0,
        );
        removalResponses.push(0);
        await js(
          `document.querySelector('[data-folder-delete="' + CSS.escape(${JSON.stringify(oldFolderKey)}) + '"]').click()`,
        );
        await agreeToReview();
        await until(
          () => removalDialogs.length === 1,
          "filtered folder confirmation",
        );
        assert.match(removalDialogs[0].message, /11 worktrees/);
        // The preview is bounded, so a long path loses its middle and a
        // worktree that would lose files gains a note. What identifies a
        // line is how its path ends.
        const listed = (dialog, tail) =>
          dialog.detail
            .split("\n")
            .some((line) => line.replace(/ — [^—]*$/, "").endsWith(tail));
        assert.ok(listed(removalDialogs[0], "/sessions/old/tree-1"));
        assert.ok(!listed(removalDialogs[0], "/sessions/old/tree-0"));
        assert.ok(!listed(removalDialogs[0], "/sessions/old/tree-2"));
        await until(
          () => js("window.arbor.getState().then(s=>!s.busy)"),
          "cancel filtered deletion",
        );
        await js(
          `document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input'))`,
        );
        await until(
          () =>
            js(
              "document.querySelectorAll('#worktree-list tr[data-id]').length===40",
            ),
          "unfiltered rows restored",
        );
        removalResponses.push(0);
        await js(
          `document.querySelector('[data-folder-delete="' + CSS.escape(${JSON.stringify(oldFolderKey)}) + '"]').click()`,
        );
        await agreeToReview();
        await until(
          () => removalDialogs.length === 2,
          "folder delete confirmation",
        );
        await until(
          () => js("window.arbor.getState().then(s=>!s.busy)"),
          "cancel folder deletion",
        );
        // The folder holds a worktree with ignored files, so this is not a
        // clean delete, and the dialog leads with exactly what would go.
        assert.equal(removalDialogs[1].title, "Delete worktrees?");
        assert.match(
          removalDialogs[1].detail,
          /^Discards ignored files\./,
        );
        assert.ok(listed(removalDialogs[1], "/sessions/old/tree-1"));
        assert.ok(!removalDialogs[1].detail.includes("/sessions/recent/"));
        assert.equal(
          await js(
            "window.arbor.getState().then(s=>s.report.worktrees.length)",
          ),
          40,
        );
        removalResponses.push(1);
        await js(
          `document.querySelector('[data-folder-delete="' + CSS.escape(${JSON.stringify(oldFolderKey)}) + '"]').click()`,
        );
        await agreeToReview();
        await until(
          () =>
            js(
              "window.arbor.getState().then(s=>!s.busy && s.report.worktrees.length===20)",
            ),
          "incremental folder deletion",
        );
        const afterDelete = fs
          .readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.equal(
          afterDelete.filter((args) => args[0] === "list").length,
          1,
          "deletion must not rescan",
        );
        const removals = afterDelete.filter((args) => args[0] === "remove");
        assert.equal(removals.length, 20);
        assert.ok(
          removals.every((args) => args.at(-1).startsWith(oldFolder + "/")),
        );
        assert.equal(
          removals.filter((args) => args.includes("--discard-local")).length,
          1,
        );
        assert.equal(
          removals.filter((args) => args.includes("--keep-local")).length,
          19,
        );
        assert.equal(
          removalDialogs.length,
          3,
          "one confirmation per folder action",
        );
        await until(
          () =>
            js(
              "document.querySelectorAll('#worktree-list tr[data-id]').length===20",
            ),
          "deleted rows disappear",
        );
        await until(
          () =>
            js(
              "!document.querySelector('#refresh-button').disabled && document.querySelector('#scan-progress').hidden",
            ),
          "cleanup controls settle immediately",
          1500,
        );
        win.setSize(850, 560);
        await pause(150);
        const sidebar = await js(`(() => {
          const list = document.querySelector('#repo-list');
          const settings = document.querySelector('#settings-button');
          const sidebar = document.querySelector('#workspace-sidebar');
          const before = settings.getBoundingClientRect();
          list.scrollTop = list.scrollHeight;
          const after = settings.getBoundingClientRect();
          return { scrolls: list.scrollHeight > list.clientHeight,
            top: before.top, afterTop: after.top, bottom: after.bottom,
            height: innerHeight, overflow: sidebar.scrollHeight - sidebar.clientHeight,
            visible: settings.contains(document.elementFromPoint(after.x + after.width / 2, after.y + after.height / 2)) };
        })()`);
        assert.equal(sidebar.scrolls, true);
        assert.equal(sidebar.top, sidebar.afterTop);
        assert.ok(sidebar.top >= 0 && sidebar.bottom <= sidebar.height);
        assert.ok(sidebar.overflow <= 1);
        assert.equal(sidebar.visible, true);
        if (process.env.ARBOR_FLOW_SCREENSHOT) {
          const capture = await win.webContents.capturePage();
          fs.writeFileSync(process.env.ARBOR_FLOW_SCREENSHOT, capture.toPNG());
        }
        await js("document.querySelector('#refresh-button').click()");
        await until(
          () =>
            js(
              "window.arbor.getState().then(s=>s.busy && s.report?.worktrees.some(row=>row.pending))",
            ),
          "second scan live results",
        );
        // One scanning host is stopped from its own row; "Stop all" would say
        // the same thing twice, so it appears only with several.
        await until(
          () =>
            js(
              "(() => { const stop = document.querySelector('[data-stop-host=\"\"]'); return !!stop && !stop.disabled && stop.getClientRects().length > 0; })()",
            ),
          "stop scan control",
        );
        assert.equal(
          await js("document.querySelector('#progress-heading').hidden"),
          true,
        );
        assert.equal(
          await js("document.querySelector('#settings-stop-scan')"),
          null,
        );
        await js("document.querySelector('[data-stop-host=\"\"]').click()");
        await until(
          () => js("window.arbor.getState().then(s=>!s.busy && s.cancelled)"),
          "scan cancellation",
        );
        const stopped = await js("window.arbor.getState()");
        const stoppedSource = stopped.hosts.find((host) => host.host === "");
        assert.ok(stoppedSource.report, "cancellation retains completed report metadata");
        assert.ok(stoppedSource.revision);
        assert.equal(stoppedSource.worktreeCount, stopped.report.worktrees.filter((row) => row.host === "").length);
        assert.ok(stopped.report.worktrees.some((row) => row.pending));
        assert.equal(stopped.report.worktrees.filter((row) => !row.pending).length, 20);
        assert.ok(stopped.report.worktrees.filter((row) => row.pending).every((row) => !row.canRemove && !row.canDiscard && !row.recommended));
        await until(
          () => js("!document.querySelector('#settings-save').disabled"),
          "settings enabled after cancellation",
        );
        await until(
          () =>
            js(
              "document.querySelector('#host-progress-list').textContent.toLowerCase().includes('stopped')",
            ),
          "stopped scan message",
        );
        assert.equal(
          await js("document.querySelector('#cleanup-button').disabled"),
          false,
          "cached recommendations remain available after stopping a refresh",
        );
        // Delete recommended sits beside Refresh and deletes nothing by
        // itself. It opens a review of what it would delete, and why, and the
        // deleting is a second decision made there. Real pointer and key
        // events are used: a double-click and a held Enter are single
        // gestures that a pair of synthetic clicks cannot tell apart from two
        // decisions.
        const review = () =>
          js(
            `(() => { const dialog = document.querySelector('#cleanup-dialog'); return { open: dialog.open, title: document.querySelector('#cleanup-title').textContent, names: [...dialog.querySelectorAll('.cleanup-name')].map((node) => node.textContent), reasons: [...dialog.querySelectorAll('.cleanup-reason')].map((node) => node.textContent), total: document.querySelector('#cleanup-total').textContent, confirm: document.querySelector('#cleanup-confirm').textContent.trim(), focus: document.activeElement?.id || '' }; })()`,
          );
        const removeCalls = () =>
          fs
            .readFileSync(calls, "utf8")
            .split("\n")
            .filter((line) => line.includes('"remove"')).length;
        const label = await js(
          `document.querySelector('#cleanup-button [data-current="true"]').textContent.trim()`,
        );
        assert.match(label, /^Delete recommended \(\d+\)…$/);
        const expected = Number(label.match(/\d+/)[0]);
        assert.equal((await review()).open, false);
        const removalsBefore = removeCalls();
        const at = await js(
          `(() => { const r = document.querySelector('#cleanup-button').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
        );
        const mouse = (type, clickCount) =>
          win.webContents.sendInputEvent({
            type,
            x: at.x,
            y: at.y,
            button: "left",
            clickCount,
          });
        mouse("mouseDown", 1);
        mouse("mouseUp", 1);
        mouse("mouseDown", 2);
        mouse("mouseUp", 2);
        await until(async () => (await review()).open, "the review opens");
        await pause(300);
        const asked = await review();
        assert.equal(
          asked.open,
          true,
          "the rest of a double-click neither answers the review nor closes it",
        );
        // What: every recommendation the list shows, by name. Why: each one's
        // own evidence.
        assert.equal(asked.names.length, expected);
        assert.ok(asked.names.every((name) => /^tree-\d+$/.test(name)));
        assert.equal(asked.reasons.length, expected);
        assert.ok(asked.reasons.every(Boolean));
        assert.equal(
          asked.title,
          `Delete these ${expected} recommended worktrees?`,
        );
        assert.match(asked.total, /^About .+ to recover · This computer$/);
        assert.equal(asked.confirm, `Delete ${expected} worktrees`);
        assert.equal(removeCalls(), removalsBefore);
        // Escape closes it.
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until(async () => !(await review()).open, "Escape cancels");
        // A held Enter: one press opens the review, and the answer that
        // deletes nothing has the keyboard. The keyboard's own repeats of
        // that press must not go on to answer it.
        await js("document.querySelector('#cleanup-button').focus()");
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        await until(async () => (await review()).open, "Enter opens the review");
        assert.equal((await review()).focus, "cleanup-cancel");
        await js(
          `(() => { window.__repeats = []; document.querySelector('#cleanup-dialog').addEventListener('keydown', (event) => { if (event.repeat) window.__repeats.push(event.defaultPrevented); }); })()`,
        );
        for (let i = 0; i < 5; i++) {
          win.webContents.sendInputEvent({
            type: "keyDown",
            keyCode: "Enter",
            modifiers: ["isAutoRepeat"],
          });
          win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        }
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        await until(
          () => js("window.__repeats.length >= 5"),
          "repeated key events reached the review",
        );
        await pause(200);
        assert.ok(
          (await js("window.__repeats")).every(Boolean),
          "each repeat is refused before it can press a button",
        );
        assert.equal((await review()).open, true, "a held key does not answer");
        // A fresh Enter lands on Cancel.
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        await until(async () => !(await review()).open, "Enter is Cancel");
        // However little room there is, what would be deleted stays in view
        // and can be scrolled, and the buttons come after it, not instead of
        // it: the smallest window, at more than twice the size.
        const roomy = win.getContentSize();
        win.setContentSize(850, 560);
        win.webContents.setZoomFactor(2.25);
        await pause(400);
        await js("document.querySelector('#cleanup-button').click()");
        await until(async () => (await review()).open, "the review opens small");
        const cramped = await js(
          `(() => { const inside = (node) => { node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 && r.height > 0; }; const dialog = document.querySelector('#cleanup-dialog'), body = document.querySelector('#cleanup-body'), items = [...body.querySelectorAll('.cleanup-item')], at = body.getBoundingClientRect(), confirm = document.querySelector('#cleanup-confirm').getBoundingClientRect(); return { focus: document.activeElement?.id || '', items: items.length, height: Math.round(at.height), first: at.top >= 0 && at.top < innerHeight - 40, hidden: confirm.bottom > innerHeight || confirm.top >= dialog.getBoundingClientRect().bottom, reached: [items[0], items.at(-1), document.querySelector('#cleanup-cancel'), document.querySelector('#cleanup-confirm')].map(inside) }; })()`,
        );
        assert.equal(cramped.items, expected);
        assert.ok(cramped.height >= 60, `the review has room: ${cramped.height}px`);
        assert.equal(cramped.first, true, "what is being asked is seen first");
        assert.equal(
          cramped.focus,
          "cleanup-title",
          "the keyboard starts at the heading, not on a Cancel out of sight",
        );
        assert.deepEqual(
          cramped.reached,
          [true, true, true, true],
          "every worktree and both buttons can be scrolled to",
        );
        await js("document.querySelector('#cleanup-dialog').close()");
        win.webContents.setZoomFactor(1);
        win.setContentSize(...roomy);
        await pause(400);
        assert.equal(
          removeCalls(),
          removalsBefore,
          "a review that is not agreed to deletes nothing",
        );
        assert.equal(
          await js(
            "[...document.querySelectorAll('[data-delete]')].filter(button=>!button.disabled).length",
          ),
          20,
          "only the twenty previously verified rows remain deletable",
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
        await js(
          `window.arbor.getPreferences().then(p => window.arbor.savePreferences({...p, hosts:[{host:'fixture-vps',name:'Fixture VPS',root:'~'}], theme:'dark'}))`,
        );
        await js("document.querySelector('#settings-button').click()");
        await until(
          () => js("document.querySelector('#settings-dialog').open"),
          "reset settings",
        );
        const beforeReset = fs.readFileSync(preferences, "utf8");
        await js(
          "document.querySelector('#scan-root').value = '/unsaved-form-value'",
        );
        resetResponses.push(0);
        await js("document.querySelector('#reset-preferences').click()");
        await until(
          () => js("!document.querySelector('#reset-preferences').disabled"),
          "cancelled reset",
        );
        assert.equal(resetDialogs, 1);
        assert.equal(fs.readFileSync(preferences, "utf8"), beforeReset);
        assert.equal(
          await js("document.querySelector('#scan-root').value"),
          "/unsaved-form-value",
        );
        assert.equal(
          await js("document.querySelector('#settings-dialog').open"),
          true,
        );
        const scanCalls = () => fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse).filter((args) => args[0] === "list");
        const previousLocalCalls = scanCalls().filter((args) => !args.includes("--host")).length;
        const previousLocalStart = (await js("window.arbor.getState()")).hosts.find((host) => host.host === "").progress.startedAt;
        await js(
          "document.querySelector('#settings-dialog').close(); document.querySelector('#refresh-button').click()",
        );
        await until(
          async () => {
            const invocations = scanCalls();
            if (invocations.filter((args) => !args.includes("--host")).length !== previousLocalCalls + 1 ||
                !invocations.some((args) => args.includes("--host") && args[args.indexOf("--host") + 1] === "fixture-vps")) return false;
            const current = await js("window.arbor.getState()");
            const source = current.hosts.find((host) => host.host === "");
            return source.busy && source.canCancelScan && source.progress?.stage !== "queued" &&
              source.progress?.startedAt > previousLocalStart && current.report?.worktrees.some((row) => row.host === "" && row.pending);
          },
          "new local scan and added-host CLI actually started before reset",
        );
        assert.equal(scanCalls().length, 5, "all intended scans started before reset confirmation");
        await js("document.querySelector('#settings-button').click()");
        await until(
          () =>
            js(
              "document.querySelector('#settings-dialog').open && !document.querySelector('#reset-preferences').disabled",
            ),
          "reset available during scan",
        );
        resetResponses.push(1);
        await js("document.querySelector('#reset-preferences').click()");
        await until(
          () => js("document.querySelector('#setup-dialog').open"),
          "fresh wizard after reset",
        );
        const resetState = await js("window.arbor.getState()");
        assert.equal(resetState.busy, false);
        assert.equal(resetState.setupRequired, true);
        assert.equal(resetState.report, null);
        assert.ok(resetState.hosts.every((host) => host.revision === null && host.report === null));
        assert.equal(resetState.worktreeCount, 0);
        assert.ok(resetState.hosts.every((host) => host.worktreeCount === 0));
        assert.equal(
          await js("document.querySelector('#setup-dialog').dataset.step"),
          "1",
        );
        const defaults = require("../desktop/protocol.cjs").validatePreferences(
          {},
        );
        assert.deepEqual(
          JSON.parse(fs.readFileSync(preferences, "utf8")),
          defaults,
        );
        assert.deepEqual(await js("window.arbor.getPreferences()"), defaults);
        assert.equal(resetDialogs, 2);
        await pause(1200);
        const finalCalls = fs
          .readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.equal(
          finalCalls.filter((args) => args[0] === "list").length,
          5,
          "reset must not automatically scan",
        );
        // Twenty by a folder's Delete here, and the thirty-nine the restarted
        // app agreed to in its review.
        assert.equal(
          finalCalls.filter((args) => args[0] === "remove").length,
          59,
        );
        assert.equal(
          fs.readFileSync(path.join(root, "preserve-me"), "utf8"),
          "untouched",
        );
      }
      console.log(
        `Desktop flow passed (${resumed ? "configured restart" : "first launch, pinned settings, cancel/confirm reset"}): wizard, live rows, progress, cleanup gating, glob preferences`,
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
