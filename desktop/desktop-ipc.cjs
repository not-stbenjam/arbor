"use strict";

const { DEFAULTS } = require("./protocol.cjs");
const { removalConfirmationOptions } = require("./worktree-menu.cjs");

function registerDesktopIPC({
  app,
  ipcMain,
  dialog,
  shell,
  clipboard,
  backend,
  preferences,
  getWindow,
  rendererURL,
  showWorktreeMenu,
}) {
  let removalConfirmation;
  const guardInteraction = () => backend.assertInteractive();
  function trusted(event) {
    const window = getWindow();
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
    handle("arbor:get-defaults", () => DEFAULTS);
    handle("arbor:get-state", () => backend.getState());
    handle("arbor:get-stats", () => backend.readStats());
    handle("arbor:activate-workspace", (options) => {
      return backend.configureWorkspace(
        options,
        (scan) => preferences.saveScan(scan, { theme: options?.theme }),
        { restore: true },
      );
    });
    handle("arbor:inspect-worktree", (value) => {
      guardInteraction();
      return backend.inspectWorktree(value);
    });
    handle("arbor:worktree-menu", showWorktreeMenu);
    handle("arbor:cancel-scan", () => {
      guardInteraction();
      return backend.cancelScan();
    });
    handle("arbor:scan", (options) => {
      return backend.configureWorkspace(options, (scan) =>
        preferences.saveScan(scan, { theme: options?.theme }),
      );
    });
    handle("arbor:complete-setup", async (value) => {
      return backend.completeSetup(value, (options) =>
        preferences.saveScan(options, {
          setupCompleted: true,
          theme: value?.theme,
        }),
      );
    });
    handle("arbor:remove", async (selection) => {
      guardInteraction();
      const result = await backend.remove(
        selection,
        async (trees, { discardLocal }) => {
          removalConfirmation = new AbortController();
          try {
            const response = await dialog.showMessageBox(getWindow(), {
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
      return result;
    });
    handle("arbor:choose-folder", async () => {
      const state = backend.getState();
      const result = await dialog.showOpenDialog(getWindow(), {
        title: "Choose a scan folder",
        properties: ["openDirectory"],
        defaultPath: state.host ? undefined : state.root || app.getPath("home"),
      });
      return result.canceled ? null : result.filePaths[0] || null;
    });
    handle("arbor:get-preferences", () => preferences.get());
    handle("arbor:save-preferences", async (value) => {
      guardInteraction();
      return preferences.saveEditable(value);
    });
    handle("arbor:reset-preferences", async () => {
      const result = await backend.resetPreferences(
        async (signal) => {
          const response = await dialog.showMessageBox(getWindow(), {
            signal,
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
          return response.response === 1;
        },
        () => preferences.reset(),
      );
      return { ...result, preferences: preferences.get() };
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

  registerIPC();
  return Object.freeze({ getRemovalConfirmation: () => removalConfirmation });
}

module.exports = { registerDesktopIPC };
