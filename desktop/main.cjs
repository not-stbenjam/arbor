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
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const { registerSmokeTest } = require("./smoke-runner.cjs");
const { createWindowLifecycle } = require("./window-lifecycle.cjs");
const { execute, childEnvironment } = require("./process-runner.cjs");
const { WorkspaceCoordinator } = require("./workspace-coordinator.cjs");
const { scanOptions } = require("./protocol.cjs");
const { PreferencesStore } = require("./preferences-store.cjs");
const {
  installApplicationMenu,
  setMenuAvailability,
} = require("./application-menu.cjs");
const { createWorktreeContextMenu } = require("./context-menu.cjs");
const { registerDesktopIPC } = require("./desktop-ipc.cjs");

registerSmokeTest({ app });

let window, backend, preferences, desktopIPC;
const { guardClose } = createWindowLifecycle({
  app,
  dialog,
  getWindow: () => window,
  getBackend: () => backend,
  getRemovalConfirmation: () => desktopIPC?.getRemovalConfirmation(),
});
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
    title: "Arbor (Alpha)",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f2023" : "#f6f6f7",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 14 } }
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
  window.on("close", guardClose);
  window.on("closed", () => {
    window = null;
  });
  window.loadFile(rendererPath);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

app.setName("Arbor");
app.on("before-quit", (event) => guardClose(event, true));
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app
  .whenReady()
  .then(async () => {
    preferences = await PreferencesStore.open(
      path.join(app.getPath("userData"), "preferences.json"),
      {
        onChange: (value) => {
          nativeTheme.themeSource = value.theme;
        },
      },
    );
    if (
      process.env.ARBOR_SMOKE_TEST === "1" &&
      ["system", "light", "dark"].includes(process.env.ARBOR_SMOKE_THEME)
    )
      await preferences.saveEditable({
        ...preferences.get(),
        theme: process.env.ARBOR_SMOKE_THEME,
      });
    const saved = preferences.get();
    nativeTheme.themeSource = saved.theme;
    const binary = cliPath();
    const explicitLaunch =
      process.argv.includes("--path") ||
      process.argv.includes("--host") ||
      process.env.ARBOR_SMOKE_TEST === "1";
    const host = explicitLaunch ? argument("--host") : saved.scan.host;
    const savedRoot = explicitLaunch
      ? host
        ? saved.hosts.find((entry) => entry.host === host)?.root || "~"
        : ""
      : saved.scan.root;
    const options = scanOptions({
      root: argument("--path") || savedRoot,
      host,
      github: explicitLaunch
        ? process.argv.includes("--github")
        : saved.scan.github,
      fetch: explicitLaunch
        ? process.argv.includes("--fetch")
        : saved.scan.fetch,
      excludes: saved.scan.excludes,
    });
    const workspaceCache = await WorkspaceCache.open(
      path.join(app.getPath("userData"), "workspace-cache.json"),
    );
    backend = new WorkspaceCoordinator({
      binary,
      cache: workspaceCache,
      version: `v${app.getVersion()}`,
      options,
      sessionHost: explicitLaunch ? options.host : undefined,
      setupRequired: !explicitLaunch && !saved.setupCompleted,
    });
    if (!explicitLaunch) {
      await backend.synchronizeHosts(saved);
      const configured = backend.getState().hosts;
      backend.setHostFilter(
        configured.some((source) => source.host === saved.hostFilter)
          ? saved.hostFilter
          : null,
      );
    } else backend.setHostFilter(host);
    const showWorktreeMenu = createWorktreeContextMenu({
      backend,
      getWindow: () => window,
      Menu,
      dialog,
      shell,
      clipboard,
      sendAction,
    });
    desktopIPC = registerDesktopIPC({
      app,
      ipcMain,
      dialog,
      backend,
      preferences,
      getWindow: () => window,
      rendererURL,
      showWorktreeMenu,
      setMenuAvailability: (commands) => setMenuAvailability(Menu, commands),
    });
    installApplicationMenu({ app, Menu, shell, sendAction });
    createWindow();
    execute("gh", ["--version"], { timeout: 3000, env: childEnvironment() })
      .then(() => {
        backend.setGitHubAvailable(true);
      })
      .catch(() => {});
    await backend.start({
      refresh: explicitLaunch,
      ...(explicitLaunch ? { host } : {}),
    });
    app.on("activate", () => {
      if (!window) {
        createWindow();
        backend.reopen().catch(() => {});
      }
    });
  })
  .catch((error) => {
    dialog.showErrorBox("Arbor could not start", error.message);
    app.quit();
  });

module.exports = { cliPath };
