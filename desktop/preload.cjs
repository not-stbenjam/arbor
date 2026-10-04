"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "arbor",
  Object.freeze({
    getDefaults: () => ipcRenderer.invoke("arbor:get-defaults"),
    getState: () => ipcRenderer.invoke("arbor:get-state"),
    getStats: () => ipcRenderer.invoke("arbor:get-stats"),
    activateWorkspace: (options) =>
      ipcRenderer.invoke("arbor:activate-workspace", options),
    scan: (options) => ipcRenderer.invoke("arbor:scan", options),
    completeSetup: (options) =>
      ipcRenderer.invoke("arbor:complete-setup", options),
    cancelScan: () => ipcRenderer.invoke("arbor:cancel-scan"),
    remove: (selection) => ipcRenderer.invoke("arbor:remove", selection),
    chooseFolder: () => ipcRenderer.invoke("arbor:choose-folder"),
    getPreferences: () => ipcRenderer.invoke("arbor:get-preferences"),
    savePreferences: (preferences) =>
      ipcRenderer.invoke("arbor:save-preferences", preferences),
    resetPreferences: () => ipcRenderer.invoke("arbor:reset-preferences"),
    openExternal: (url) => ipcRenderer.invoke("arbor:open-external", url),
    copyText: (text) => ipcRenderer.invoke("arbor:copy-text", text),
    showWorktreeMenu: (selection) =>
      ipcRenderer.invoke("arbor:worktree-menu", selection),
    inspectWorktree: (selection) =>
      ipcRenderer.invoke("arbor:inspect-worktree", selection),
    onMenuAction: (callback) => {
      if (typeof callback !== "function")
        throw new TypeError("Menu callback must be a function");
      const listener = (_event, action) => callback(action);
      ipcRenderer.on("arbor:menu-action", listener);
      return () => ipcRenderer.removeListener("arbor:menu-action", listener);
    },
  }),
);
