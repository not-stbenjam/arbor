"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  clipboard,
  nativeTheme,
} = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const {
  menuTarget,
  terminalCommand,
  removalConfirmationOptions,
} = require("./worktree-menu.cjs");
const { pathToFileURL } = require("node:url");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const {
  Backend,
  execute,
  validatePreferences,
  loadPreferences,
  childEnvironment,
  scanOptions,
} = require("./backend.cjs");

let window,
  backend,
  preferences = validatePreferences({}),
  setupCompleting = false,
  resetPending = false,
  quitAfterRemoval = false,
  quitDialog = false;
let removalConfirmation;
let closingScan = false,
  quitAfterScan = false;
let preferenceWrite = Promise.resolve();
const rendererPath = path.join(__dirname, "renderer", "index.html");
const rendererURL = pathToFileURL(rendererPath).href;

function cliPath() {
  if (!app.isPackaged && process.env.ARBOR_CLI_PATH)
    return process.env.ARBOR_CLI_PATH;
  if (app.isPackaged)
    return path.join(process.resourcesPath, "bin", "arbor-cli");
  const current = path.join(__dirname, "..", "bin", "arbor-cli");
  return fs.existsSync(current)
    ? current
    : path.join(__dirname, "..", "bin", "arbor");
}

function sendAction(action) {
  if (window && !window.isDestroyed())
    window.webContents.send("arbor:menu-action", action);
}

function menu() {
  const mac = process.platform === "darwin";
  const template = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: "Command+,",
                click: () => sendAction("settings"),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Refresh Worktrees",
          accelerator: "CmdOrCtrl+R",
          click: () => sendAction("refresh"),
        },
        { label: "Add SSH Host…", click: () => sendAction("add-host") },
        { label: "Statistics…", click: () => sendAction("statistics") },
        ...(!mac
          ? [
              {
                label: "Settings…",
                accelerator: "Ctrl+,",
                click: () => sendAction("settings"),
              },
            ]
          : []),
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find Worktree",
          accelerator: "CmdOrCtrl+F",
          click: () => sendAction("focus-search"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : []),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(mac ? [{ role: "front" }] : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Arbor on GitHub",
          click: () =>
            shell.openExternal("https://github.com/not-stbenjam/arbor"),
        },
        {
          label: "Report an Issue",
          click: () =>
            shell.openExternal("https://github.com/not-stbenjam/arbor/issues"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trusted(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url.split("#")[0] !== rendererURL
  )
    throw new Error("Unrecognized application window");
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    trusted(event);
    return handler(...args);
  });
}

function registerIPC() {
  handle("arbor:get-state", () => backend.getState());
  handle("arbor:get-stats", async () => {
    const host = backend.state.host || "";
    const args = ["stats", "--json"];
    if (host) args.push("--host", host);
    const report = JSON.parse(await backend.run(args, { timeout: 30000 }));
    if (!report || report.version !== 1 || !Array.isArray(report.daily))
      throw new Error("Arbor returned invalid statistics");
    return { host, report };
  });
  handle("arbor:activate-workspace", (options) => {
    guardReset();
    if (setupCompleting) throw new Error("Setup is being saved");
    return backend.activateWorkspace(options);
  });
  handle("arbor:inspect-worktree", (value) => {
    guardReset();
    return backend.inspectWorktree(value);
  });
  handle("arbor:worktree-menu", (value) => {
    guardReset();
    const target = menuTarget(backend.state, value);
    const current = () => {
      guardReset();
      const next = menuTarget(backend.state, value);
      if (next.path !== target.path || next.host !== target.host)
        throw new Error("The worktree list changed; try the menu again");
      return next;
    };
    const click = (action) => () => {
      Promise.resolve()
        .then(() => action(current()))
        .catch((error) => {
          if (window && !window.isDestroyed())
            void dialog.showMessageBox(window, {
              type: "error",
              title: "Worktree action unavailable",
              message: error.message,
            });
        });
    };
    const localLabel = target.host ? " (local worktrees only)" : "";
    const terminal = target.local
      ? terminalCommand(process.platform, target.path, findExecutable)
      : null;
    Menu.buildFromTemplate([
      {
        label: "Copy Path",
        click: click((row) => clipboard.writeText(row.path)),
      },
      { type: "separator" },
      {
        label:
          (process.platform === "darwin"
            ? "Reveal in Finder"
            : "Show in File Manager") + localLabel,
        enabled: target.local,
        click: click(async (row) => {
          await localDirectory(row);
          shell.showItemInFolder(row.path);
        }),
      },
      {
        label: "Open Folder" + localLabel,
        enabled: target.local,
        click: click(async (row) => {
          await localDirectory(row);
          const error = await shell.openPath(row.path);
          if (error) throw new Error(error);
        }),
      },
      {
        label:
          "Open in Terminal" +
          localLabel +
          (target.local && !terminal ? " (not installed)" : ""),
        enabled: !!terminal,
        click: click(async (row) => {
          await localDirectory(row);
          const command = terminalCommand(
            process.platform,
            row.path,
            findExecutable,
          );
          if (!command) throw new Error("No supported terminal is installed");
          await launchTerminal(command);
        }),
      },
      { type: "separator" },
      ...(target.retryInspection
        ? [
            {
              label: "Retry Inspection",
              click: click((row) =>
                backend.inspectWorktree({ id: row.id, revision: row.revision }),
              ),
            },
          ]
        : []),
      {
        label: "Delete Worktree…",
        enabled: target.removable,
        click: click((row) => {
          if (!row.removable)
            throw new Error("The worktree is no longer available for deletion");
          sendAction({
            type: "worktree-remove",
            id: row.id,
            revision: row.revision,
          });
        }),
      },
    ]).popup({ window });
    return true;
  });
  handle("arbor:cancel-scan", () => {
    guardReset();
    return backend.cancelScan();
  });
  handle("arbor:scan", (options) => {
    guardReset();
    if (setupCompleting) throw new Error("Setup is being saved");
    return backend.scan(options);
  });
  handle("arbor:complete-setup", async (value) => {
    guardReset();
    const options = scanOptions(value);
    if (setupCompleting || backend.state.busy)
      throw new Error("An operation is already running");
    setupCompleting = true;
    try {
      await savePreferences(() => ({
        ...preferences,
        setupCompleted: true,
        scan: options,
      }));
      backend.state.setupRequired = false;
      return backend.scan(options);
    } finally {
      setupCompleting = false;
    }
  });
  handle("arbor:remove", async (selection) => {
    guardReset();
    const result = await backend.remove(
      selection,
      async (trees, { discardLocal }) => {
        removalConfirmation = new AbortController();
        try {
          const response = await dialog.showMessageBox(window, {
            signal: removalConfirmation.signal,
            type: "warning",
            ...removalConfirmationOptions(trees, discardLocal),
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return response.response === 1;
        } finally {
          removalConfirmation = null;
        }
      },
    );
    if (quitAfterRemoval) setImmediate(() => app.quit());
    return result;
  });
  handle("arbor:choose-folder", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a scan folder",
      properties: ["openDirectory"],
      defaultPath: backend.state.host
        ? undefined
        : backend.state.root || app.getPath("home"),
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  handle("arbor:get-preferences", () => structuredClone(preferences));
  handle("arbor:save-preferences", async (value) => {
    guardReset();
    const next = validatePreferences(value);
    return savePreferences(() => ({
      ...next,
      setupCompleted: preferences.setupCompleted,
      scan: value.scan === undefined ? preferences.scan : next.scan,
    }));
  });
  handle("arbor:reset-preferences", async () => {
    guardReset();
    if (setupCompleting) throw new Error("Setup is being saved");
    if (backend.operation === "remove")
      throw new Error("Wait for cleanup to finish before resetting Arbor");
    if (backend.state.busy && backend.operation !== "scan")
      throw new Error("Wait for inspection to finish before resetting Arbor");
    if (backend.disposed) throw new Error("Arbor is closing");
    resetPending = true;
    try {
      const response = await dialog.showMessageBox(window, {
        type: "warning",
        title: "Reset Arbor?",
        message: "Reset Arbor to its defaults?",
        detail:
          "Saved SSH hosts, scan folders, exclusion rules, and appearance settings will be reset. The setup wizard will reopen without starting a scan. Repositories and worktrees will not be changed or deleted. Statistics are kept. Any running scan will be stopped.",
        buttons: ["Cancel", "Reset Arbor"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response.response !== 1)
        return {
          cancelled: true,
          state: backend.getState(),
          preferences: structuredClone(preferences),
        };
      if (backend.operation === "scan") {
        backend.cancelScan();
        await backend.pending;
      }
      const defaults = await savePreferences(() => validatePreferences({}));
      const state = backend.reset();
      await backend.cache.pending;
      return {
        cancelled: false,
        state,
        preferences: defaults,
      };
    } finally {
      resetPending = false;
    }
  });
  handle("arbor:open-external", async (value) => {
    if (typeof value !== "string" || value.length > 4096)
      throw new Error("Invalid link");
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid link");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      throw new Error("Only HTTPS links to GitHub can be opened");
    await shell.openExternal(url.href);
    return true;
  });
  handle("arbor:copy-text", async (value) => {
    if (typeof value !== "string" || value.length > 1024 * 1024)
      throw new Error("Invalid clipboard text");
    await clipboard.writeText(value);
    return true;
  });
}

function guardReset() {
  if (resetPending) throw new Error("Arbor reset is in progress");
}

async function localDirectory(target) {
  if (!target.local || target.host)
    throw new Error("This action is only available for local worktrees");
  const info = await fsp.stat(target.path);
  if (!info.isDirectory())
    throw new Error("The worktree directory no longer exists");
}

function findExecutable(name) {
  for (const directory of (childEnvironment().PATH || "").split(
    path.delimiter,
  )) {
    if (!path.isAbsolute(directory)) continue;
    const binary = path.join(directory, name);
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      if (fs.statSync(binary).isFile()) return binary;
    } catch {
      /* Try the next PATH directory. */
    }
  }
  return null;
}

function launchTerminal(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      cwd: command.cwd,
      env: childEnvironment(),
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function savePreferences(nextValue) {
  const save = async () => {
    const next = validatePreferences(nextValue());
    const directory = app.getPath("userData");
    await fsp.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `preferences-${process.pid}.tmp`);
    await fsp.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600,
    });
    await fsp.rename(temporary, path.join(directory, "preferences.json"));
    preferences = next;
    nativeTheme.themeSource = preferences.theme;
    return structuredClone(preferences);
  };
  preferenceWrite = preferenceWrite.then(save, save);
  return preferenceWrite;
}

function guardQuit(event, applicationQuit = false) {
  if (backend?.operation === "scan" || backend?.operation === "inspect") {
    event.preventDefault();
    quitAfterScan ||= applicationQuit;
    if (!closingScan) {
      closingScan = true;
      backend.dispose();
      const finishClose = () => {
        closingScan = false;
        if (quitAfterScan) app.quit();
        else if (window && !window.isDestroyed()) window.close();
      };
      backend.pending.then(finishClose, finishClose);
    }
    return;
  }
  if (backend?.operation !== "remove") {
    backend?.dispose();
    return;
  }
  event.preventDefault();
  if (removalConfirmation) {
    quitAfterRemoval = true;
    backend.stopCleanupAfterCurrent();
    removalConfirmation.abort();
    backend.pending.finally(() => app.quit());
    return;
  }
  if (quitDialog || quitAfterRemoval) return;
  quitDialog = true;
  dialog
    .showMessageBox(window, {
      type: "info",
      title: "Cleanup is running",
      message: "Finish the current worktree, then quit?",
      detail:
        "Arbor will finish the one worktree currently being removed, leave the remaining worktrees untouched, and quit without rescanning.",
      buttons: ["Keep Arbor Open", "Finish Current & Quit"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      quitAfterRemoval = response === 1;
      if (quitAfterRemoval) {
        if (backend.operation === "remove") backend.stopCleanupAfterCurrent();
        backend.pending.finally(() => app.quit());
      }
    })
    .finally(() => {
      quitDialog = false;
    });
}

function createWindow() {
  const icon = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "..", "build", "icons", "icon.png");
  window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 850,
    minHeight: 560,
    show: false,
    title: "Arbor",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f2023" : "#f6f6f7",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    ...(fs.existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  window.webContents.session.webRequest.onHeadersReceived((details, callback) =>
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'",
        ],
      },
    }),
  );
  window.once("ready-to-show", () => window.show());
  window.on("close", guardQuit);
  window.on("closed", () => {
    window = null;
  });
  window.loadFile(rendererPath);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

// Exercise the installed renderer, preload, IPC, and CLI together under Xvfb.
// The opt-in smoke mode always requires an explicit, isolated scan folder.
if (process.env.ARBOR_SMOKE_TEST === "1") {
  const root = process.env.ARBOR_SMOKE_ROOT;
  if (!root) {
    console.error("ARBOR_SMOKE_ROOT is required");
    app.exit(1);
  } else process.argv.push("--path", root);
  app.on("browser-window-created", (_event, win) => {
    const consoleErrors = [];
    win.webContents.on("console-message", (...args) => {
      const details = args.find(
        (value) => value && typeof value === "object" && "message" in value,
      );
      const level = details?.level ?? args[1],
        message = details?.message ?? args[2];
      if (level === 3 || level === "error") consoleErrors.push(String(message));
    });
    win.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`Arbor renderer failed to load: ${code} ${description}`);
      app.exit(1);
    });
    win.webContents.once("did-finish-load", async () => {
      try {
        const deadline = Date.now() + 25000;
        let state;
        do {
          state = await win.webContents.executeJavaScript(
            "window.arbor.getState()",
          );
          if (!state.busy) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        if (
          state.busy ||
          state.error ||
          !state.report ||
          !Array.isArray(state.report.worktrees)
        )
          throw new Error(state.error || "Smoke scan did not complete");
        if (process.env.ARBOR_SMOKE_CLEANUP === "1") {
          const canonical = fs.realpathSync(root),
            temporaryRoot = fs.realpathSync(os.tmpdir());
          const relative = path.relative(temporaryRoot, canonical);
          if (
            !relative ||
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            !fs.existsSync(path.join(canonical, ".arbor-smoke-fixture"))
          )
            throw new Error(
              "Cleanup smoke requires a marked, disposable fixture beneath the temporary directory",
            );
          const candidates = state.report.worktrees.filter(
            (w) => w.recommended,
          );
          if (!candidates.length)
            throw new Error("Cleanup smoke fixture has no recommendations");
          const before = state.report.worktrees.length;
          const selection = {
            items: candidates.map((w) => ({ id: w.id, head: w.head })),
            revision: state.revision,
            recommendedOnly: true,
          };
          const removed = await win.webContents.executeJavaScript(
            `window.arbor.remove(${JSON.stringify(selection)})`,
          );
          if (
            removed.results?.length !== candidates.length ||
            removed.results.some((result) => !result.removed)
          )
            throw new Error(
              "Cleanup smoke could not remove every recommendation",
            );
          state = await win.webContents.executeJavaScript(
            "window.arbor.getState()",
          );
          if (
            state.error ||
            state.report.worktrees.length !== before - candidates.length
          )
            throw new Error(
              "Cleanup smoke did not refresh the worktree report",
            );
          console.log(
            `Arbor cleanup smoke passed: removed ${candidates.length} fixture worktrees through Electron IPC`,
          );
        }
        let rendered;
        for (let attempt = 0; attempt < 50; attempt++) {
          rendered = await win.webContents.executeJavaScript(
            `({ text: document.body.innerText, rows: document.querySelectorAll('#worktree-list tr[data-id]').length, count: document.querySelector('#all-count')?.textContent, status: document.querySelector('#status-message')?.textContent, error: document.querySelector('#error-banner')?.hidden === false })`,
          );
          if (
            Number(rendered.count) === state.report.worktrees.length &&
            rendered.rows === state.report.worktrees.length &&
            rendered.status?.includes("repositories")
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (
          rendered.text.trim().length < 20 ||
          Number(rendered.count) !== state.report.worktrees.length ||
          rendered.rows !== state.report.worktrees.length ||
          !rendered.status?.includes("repositories")
        )
          throw new Error("Renderer did not display the completed scan");
        if (rendered.error || consoleErrors.length)
          throw new Error(
            `Renderer reported an error: ${consoleErrors.join("; ") || "error banner visible"}`,
          );
        if (process.env.ARBOR_SMOKE_SCREENSHOT) {
          win.setContentSize(1240, 800);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const image = await win.webContents.capturePage();
          await fsp.writeFile(
            process.env.ARBOR_SMOKE_SCREENSHOT,
            image.toPNG(),
          );
        }
        console.log(
          `Arbor Electron smoke passed: ${state.report.worktrees.length} worktrees; preload, IPC, CLI, and renderer ready`,
        );
        app.exit(0);
      } catch (error) {
        console.error("Arbor Electron smoke failed:", error);
        app.exit(1);
      }
    });
  });
}

app.setName("Arbor");
app.on("before-quit", (event) => guardQuit(event, true));
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app
  .whenReady()
  .then(async () => {
    try {
      preferences = loadPreferences(
        JSON.parse(
          await fsp.readFile(
            path.join(app.getPath("userData"), "preferences.json"),
            "utf8",
          ),
        ),
      );
    } catch {
      /* First launch or obsolete preferences use defaults. */
    }
    if (
      process.env.ARBOR_SMOKE_TEST === "1" &&
      ["system", "light", "dark"].includes(process.env.ARBOR_SMOKE_THEME)
    )
      preferences.theme = process.env.ARBOR_SMOKE_THEME;
    nativeTheme.themeSource = preferences.theme;
    const binary = cliPath();
    const explicitLaunch =
      process.argv.includes("--path") ||
      process.argv.includes("--host") ||
      process.env.ARBOR_SMOKE_TEST === "1";
    const host = explicitLaunch ? argument("--host") : preferences.scan.host;
    const savedRoot = explicitLaunch
      ? host
        ? preferences.hosts.find((entry) => entry.host === host)?.root || "~"
        : ""
      : preferences.scan.root;
    const options = scanOptions({
      root: argument("--path") || savedRoot,
      host,
      github: explicitLaunch
        ? process.argv.includes("--github")
        : preferences.scan.github,
      fetch: explicitLaunch
        ? process.argv.includes("--fetch")
        : preferences.scan.fetch,
      excludes: preferences.scan.excludes,
    });
    const workspaceCache = await WorkspaceCache.open(
      path.join(app.getPath("userData"), "workspace-cache.json"),
    );
    backend = new Backend({
      binary,
      cache: workspaceCache,
      version: `v${app.getVersion()}`,
      options,
      setupRequired: !explicitLaunch && !preferences.setupCompleted,
    });
    registerIPC();
    menu();
    createWindow();
    execute("gh", ["--version"], { timeout: 3000, env: childEnvironment() })
      .then(() => {
        backend.state.githubAvailable = true;
      })
      .catch(() => {});
    if (!backend.state.setupRequired) {
      if (explicitLaunch) backend.scan(options);
      else await backend.activateWorkspace(options);
    }
    app.on("activate", () => {
      if (!window) {
        createWindow();
        backend.pending.finally(() => {
          backend.disposed = false;
          if (
            window &&
            !resetPending &&
            !backend.state.setupRequired &&
            !backend.state.busy
          )
            backend.activateWorkspace(backend.options).catch(() => {});
        });
      }
    });
  })
  .catch((error) => {
    dialog.showErrorBox("Arbor could not start", error.message);
    app.quit();
  });

module.exports = { cliPath };
