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
const { pathToFileURL } = require("node:url");
const {
  Backend,
  execute,
  validatePreferences,
  childEnvironment,
  scanOptions,
} = require("./backend.cjs");

let window,
  backend,
  preferences = validatePreferences({}),
  setupCompleting = false,
  quitAfterRemoval = false,
  quitDialog = false;
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
  handle("arbor:cancel-scan", () => backend.cancelScan());
  handle("arbor:scan", (options) => {
    if (setupCompleting) throw new Error("Setup is being saved");
    return backend.scan(options);
  });
  handle("arbor:complete-setup", async (value) => {
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
    const result = await backend.remove(selection, async (trees) => {
      const response = await dialog.showMessageBox(window, {
        type: "warning",
        title: "Remove worktree?",
        message:
          trees.length === 1
            ? `Remove “${trees[0].branch}”?`
            : `Remove ${trees.length} worktrees?`,
        detail: `These worktrees are not verified cleanup recommendations. Their folders will be removed; Git branches and commits will be retained.\n\n${trees.map((w) => w.path).join("\n")}`,
        buttons: ["Cancel", "Remove Worktree" + (trees.length > 1 ? "s" : "")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return response.response === 1;
    });
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
    const next = validatePreferences(value);
    return savePreferences(() => ({
      ...next,
      setupCompleted: preferences.setupCompleted,
      scan: value.scan === undefined ? preferences.scan : next.scan,
    }));
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
  handle("arbor:copy-text", (value) => {
    if (typeof value !== "string" || value.length > 1024 * 1024)
      throw new Error("Invalid clipboard text");
    clipboard.writeText(value);
    return true;
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

function guardQuit(event) {
  if (backend?.operation !== "remove") {
    backend?.dispose();
    return;
  }
  event.preventDefault();
  if (quitDialog || quitAfterRemoval) return;
  quitDialog = true;
  dialog
    .showMessageBox(window, {
      type: "info",
      title: "Cleanup is running",
      message: "Wait for cleanup to finish before quitting.",
      detail: "Arbor is preserving the result of your worktree cleanup.",
      buttons: ["Keep Arbor Open", "Quit When Finished"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .then(({ response }) => {
      quitAfterRemoval = response === 1;
      if (quitAfterRemoval && backend.operation !== "remove") app.quit();
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
        if (
          process.env.ARBOR_SMOKE_INSPECTOR === "1" &&
          state.report.worktrees.length
        ) {
          await win.webContents.executeJavaScript(
            `document.querySelector('.worktree-row')?.click(); document.querySelector('#inspector-button')?.click()`,
          );
          if (
            !(await win.webContents.executeJavaScript(
              `document.querySelector('#inspector').hidden === false`,
            ))
          )
            throw new Error("Worktree inspector did not open");
        }
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
app.on("before-quit", guardQuit);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app
  .whenReady()
  .then(async () => {
    try {
      preferences = validatePreferences(
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
    backend = new Backend({
      binary,
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
    if (!backend.state.setupRequired) backend.scan(options);
    app.on("activate", () => {
      if (!window) {
        createWindow();
        backend.pending.finally(() => {
          backend.disposed = false;
          if (window && !backend.state.setupRequired && !backend.state.busy)
            backend.scan(backend.options);
        });
      }
    });
  })
  .catch((error) => {
    dialog.showErrorBox("Arbor could not start", error.message);
    app.quit();
  });

module.exports = { cliPath };
