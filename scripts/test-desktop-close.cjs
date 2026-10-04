"use strict";

// Real Electron lifecycle tests. Every CLI invocation is a synthetic fixture:
// no repositories are opened, scanned, or deleted.
const { app, BrowserWindow, dialog, Menu, clipboard } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(40);
  }
  throw new Error(`Timed out: ${description}`);
}

const phase = process.env.ARBOR_CLOSE_PHASE;
if (!phase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-close-test-"));
  const deadline = setTimeout(() => {
    console.error("Desktop close test timed out");
    app.exit(1);
  }, 45000);
  (async () => {
    for (const current of [
      "scan-close",
      "scan-quit",
      "cleanup",
      "confirmations",
      "reopen",
    ]) {
      const directory = path.join(root, current);
      fs.mkdirSync(directory);
      const child = spawn(
        process.execPath,
        [__filename, ...process.argv.filter((arg) => arg === "--no-sandbox")],
        {
          env: {
            ...process.env,
            ARBOR_CLOSE_PHASE: current,
            ARBOR_CLOSE_DIRECTORY: directory,
          },
          stdio: "inherit",
        },
      );
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, `${current} Electron exit`);
      const result = JSON.parse(
        fs.readFileSync(path.join(directory, "result.json"), "utf8"),
      );
      assert.ok(
        result.elapsed < 8000,
        `${current} quit took ${result.elapsed}ms`,
      );
      if (current === "reopen")
        assert.equal(
          result.reopened,
          true,
          "cached renderer was recreated after window close",
        );
      if (current.startsWith("scan")) {
        const pid = Number(
          fs.readFileSync(path.join(directory, "cli.pid"), "utf8"),
        );
        assert.throws(
          () => process.kill(pid, 0),
          { code: "ESRCH" },
          "stubborn CLI must exit before Electron",
        );
        assert.ok(
          fs.existsSync(path.join(directory, "terminated")),
          "scan received SIGTERM before fallback",
        );
      }
      console.log(`Desktop close passed: ${current} (${result.elapsed}ms)`);
    }
    clearTimeout(deadline);
    app.exit(0);
  })().catch((error) => {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  });
} else {
  const directory = process.env.ARBOR_CLOSE_DIRECTORY;
  if (
    !directory ||
    !path.basename(path.dirname(directory)).startsWith("arbor-close-test-")
  )
    throw new Error("Expected an isolated close test fixture");
  const root = path.join(directory, "projects");
  const userData = path.join(directory, "user-data");
  fs.mkdirSync(root);
  fs.mkdirSync(userData);
  fs.writeFileSync(
    path.join(userData, "preferences.json"),
    JSON.stringify({
      setupCompleted: true,
      scan: { root, host: "", github: false, fetch: false, excludes: [] },
    }),
  );
  const calls = path.join(directory, "calls.jsonl");
  const removed = path.join(directory, "removed");
  const binary = path.join(directory, "fixture-cli");
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
fs.writeFileSync(${JSON.stringify(path.join(directory, "cli.pid"))}, String(process.pid));
const root = ${JSON.stringify(root)};
const trees = [1,2].map(n=>({id:'tree-'+n,path:root+'/tree-'+n,repo:'fixture',branch:'topic-'+n,head:'a'.repeat(40),canRemove:true,recommended:true,blockers:[],problems:[],publishedRefs:[]}));
if (${JSON.stringify(phase)} === 'confirmations') {
  Object.assign(trees[0], {branch:'',detached:true,canRemove:false,canDiscard:true,recommended:false});
  Object.assign(trees[1], {branch:'develop',canRemove:false,canDiscard:true,recommended:false});
}
if (args[0] === 'remove') {
  fs.writeFileSync(${JSON.stringify(path.join(directory, "removing"))}, 'started');
  setTimeout(()=>{fs.writeFileSync(${JSON.stringify(removed)},args.at(-1));process.stdout.write(JSON.stringify({path:args.at(-1),removed:true}));},700);
} else if (${JSON.stringify(phase)}.startsWith('scan')) {
  process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(path.join(directory, "terminated"))},'received'));
  process.stderr.write('@arbor-progress '+JSON.stringify({stage:'inspect',path:root,discovered:2,completed:0,total:2,worktree:trees[0],pending:true})+'\\n');
  setInterval(()=>{},1000);
} else process.stdout.write(JSON.stringify({root,worktrees:trees,warnings:[],scannedAt:new Date().toISOString(),durationMs:10}));
`,
    { mode: 0o700 },
  );
  app.setPath("userData", userData);
  process.env.ARBOR_CLI_PATH = binary;
  delete process.env.ARBOR_SMOKE_TEST;
  let closingAt = null;
  let reopenVerified = false;
  let contextMenu;
  let copiedPath;
  const originalCopy = clipboard.writeText;
  clipboard.writeText = (value) => {
    copiedPath = value;
    return originalCopy.call(clipboard, value);
  };
  const originalMenu = Menu.buildFromTemplate;
  Menu.buildFromTemplate = (template) => {
    if (template.some((item) => item.label === "Copy Path")) {
      contextMenu = template;
      return { popup() {} };
    }
    return originalMenu.call(Menu, template);
  };
  const originalDialog = dialog.showMessageBox;
  const confirmations = [];
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1);
    if (options.title === "Cleanup is running") return { response: 1 };
    if (
      phase === "confirmations" &&
      ["Remove worktree?", "Discard local data and remove?"].includes(
        options.title,
      )
    ) {
      confirmations.push(options);
      return { response: 0 };
    }
    if (options.title === "Worktree action unavailable") {
      console.error("Native menu callback failed:", options.message);
      return { response: 0 };
    }
    return originalDialog(...args);
  };
  app.on("will-quit", () => {
    try {
      assert.ok(closingAt, "test requested close before quitting");
      const invocations = fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        invocations.filter((args) => args[0] === "list").length,
        1,
        "cleanup must not rescan",
      );
      if (phase === "cleanup") {
        assert.equal(
          invocations.filter((args) => args[0] === "remove").length,
          1,
          "only current worktree may be removed",
        );
        assert.equal(fs.readFileSync(removed, "utf8"), root + "/tree-1");
        assert.ok(
          invocations
            .find((args) => args[0] === "remove")
            .includes("--keep-local"),
        );
      } else if (phase === "confirmations") {
        assert.equal(
          invocations.length,
          1,
          "cancelled confirmations must not invoke removal",
        );
        assert.equal(confirmations.length, 2);
      } else if (phase === "reopen") {
        assert.equal(
          reopenVerified,
          true,
          "reopen checks completed before application quit",
        );
        assert.equal(
          invocations.length,
          1,
          "reopening must not invoke another scan or deletion",
        );
      }
      fs.writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({
          elapsed: Date.now() - closingAt,
          reopened: reopenVerified,
        }),
      );
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
  app.once("browser-window-created", (_event, win) => {
    win.webContents.once("did-finish-load", async () => {
      try {
        const js = (source) => win.webContents.executeJavaScript(source);
        const checkMenu = async (state) => {
          const row = state.report.worktrees[0];
          assert.ok(row, "native menu requires a projected row");
          const request = {
            id: row.id,
            revision: state.revision,
            path: "/renderer-cannot-supply-paths",
          };
          await js(`window.arbor.showWorktreeMenu(${JSON.stringify(request)})`);
          const previous = await clipboard.readText();
          contextMenu.find((item) => item.label === "Copy Path").click();
          await until(
            () => copiedPath !== undefined,
            "native menu invoked clipboard",
          );
          assert.equal(copiedPath, row.path);
          assert.equal(
            await clipboard.readText(),
            row.path,
            "clipboard roundtrip after native callback",
          );
          await clipboard.writeText(previous);
          assert.equal(
            contextMenu.find((item) => item.label === "Delete Worktree…")
              .enabled,
            !state.busy,
          );
        };
        if (["cleanup", "confirmations", "reopen"].includes(phase)) {
          const state = await until(async () => {
            const state = await js("window.arbor.getState()");
            return !state.busy && state.report ? state : null;
          }, "completed synthetic scan");
          await checkMenu(state);
          if (phase === "confirmations") {
            for (const row of state.report.worktrees) {
              const selection = {
                revision: state.revision,
                items: [{ id: row.id, head: row.head }],
                discardLocal: true,
                forceConfirm: true,
              };
              const result = await js(
                `window.arbor.remove(${JSON.stringify(selection)})`,
              );
              assert.equal(result.cancelled, true);
            }
            assert.equal(confirmations[0].message, "Remove “tree-1”?");
            assert.match(
              confirmations[0].detail,
              /recovery branches are created only if needed/,
            );
            assert.equal(confirmations[1].message, "Remove “tree-2”?");
            assert.ok(
              confirmations.every(
                (options) =>
                  options.detail.includes("Any local files") &&
                  options.buttons[1] === "Discard & Remove",
              ),
              "force-removal consent must cover files added since the cached scan",
            );
          } else if (phase === "cleanup") {
            const selection = {
              revision: state.revision,
              recommendedOnly: true,
              items: state.report.worktrees.map(({ id, head }) => ({
                id,
                head,
              })),
            };
            void js(`window.arbor.remove(${JSON.stringify(selection)})`).catch(
              () => {},
            );
            await until(
              () => fs.existsSync(path.join(directory, "removing")),
              "first synthetic removal",
            );
          } else {
            await until(
              () =>
                js(
                  "document.querySelectorAll('#worktree-list [data-id]').length === 2",
                ),
              "original renderer shows cached worktrees",
            );
            const originalWindowID = win.id;
            const closed = new Promise((resolve) =>
              win.once("closed", resolve),
            );
            win.close();
            await closed;
            await pause(50);
            assert.equal(
              BrowserWindow.getAllWindows().length,
              0,
              "the original window really closed while Electron remained alive",
            );
            const created = new Promise((resolve) =>
              app.once("browser-window-created", (_event, next) =>
                resolve(next),
              ),
            );
            app.emit("activate", {}, false);
            const reopened = await created;
            assert.notEqual(reopened.id, originalWindowID);
            await new Promise((resolve) =>
              reopened.webContents.once("did-finish-load", resolve),
            );
            const reopenedJS = (source) =>
              reopened.webContents.executeJavaScript(source);
            const restored = await until(async () => {
              const current = await reopenedJS("window.arbor.getState()");
              return !current.busy &&
                current.report &&
                current.revision !== state.revision
                ? current
                : null;
            }, "reopened workspace receives a fresh snapshot revision");
            assert.equal(restored.cached, true);
            assert.equal(restored.root, state.root);
            assert.equal(
              restored.report.scannedAt,
              state.report.scannedAt,
              "reopening preserves the completed scan timestamp",
            );
            assert.deepEqual(
              restored.report.worktrees.map((row) => row.path),
              state.report.worktrees.map((row) => row.path),
            );
            await until(
              () =>
                reopenedJS(
                  "document.querySelectorAll('#worktree-list [data-id]').length === 2 && document.querySelector('#all-count')?.textContent === '2'",
                ),
              "recreated renderer displays both cached worktrees",
            );
            assert.equal(
              await reopenedJS(
                "document.querySelector('#error-banner').hidden",
              ),
              true,
            );
            reopenVerified = true;
          }
        } else {
          await until(
            async () => {
              const current = await js("window.arbor.getState()");
              return current.busy && current.report?.worktrees.some((row) => row.pending);
            },
            "running synthetic scan",
          );
          await checkMenu(await js("window.arbor.getState()"));
        }
        closingAt = Date.now();
        if (phase === "scan-close") {
          app.once("window-all-closed", () => app.quit());
          win.close();
        } else app.quit();
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    });
  });
  const previousCloseListeners = new Set(app.listeners("window-all-closed"));
  require("../desktop/main.cjs");
  if (phase === "reopen" && process.platform !== "darwin") {
    // Exercise the same native activate path on Linux by suppressing only the
    // composition root's Linux auto-quit handler. macOS keeps its real policy.
    for (const listener of app.listeners("window-all-closed"))
      if (!previousCloseListeners.has(listener))
        app.removeListener("window-all-closed", listener);
    app.on("window-all-closed", () => {});
  }
}
