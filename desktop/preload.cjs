"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "arbor",
  Object.freeze({
    getDefaults: () => ipcRenderer.invoke("arbor:get-defaults"),
    getState: () => ipcRenderer.invoke("arbor:get-state"),
    getStats: (host) => ipcRenderer.invoke("arbor:get-stats", host),
    setHostFilter: (host) => ipcRenderer.invoke("arbor:set-host-filter", host),
    refreshHosts: (host) => ipcRenderer.invoke("arbor:refresh-hosts", host),
    scan: (options) => ipcRenderer.invoke("arbor:scan", options),
    completeSetup: (options) =>
      ipcRenderer.invoke("arbor:complete-setup", options),
    cancelScan: (host) => ipcRenderer.invoke("arbor:cancel-scan", host),
    remove: (selection) => ipcRenderer.invoke("arbor:remove", selection),
    chooseFolder: () => ipcRenderer.invoke("arbor:choose-folder"),
    getPreferences: () => ipcRenderer.invoke("arbor:get-preferences"),
    savePreferences: (preferences) =>
      ipcRenderer.invoke("arbor:save-preferences", preferences),
    resetPreferences: () => ipcRenderer.invoke("arbor:reset-preferences"),
    showWorktreeMenu: (selection) =>
      ipcRenderer.invoke("arbor:worktree-menu", selection),
    onMenuAction: (callback) => {
      if (typeof callback !== "function")
        throw new TypeError("Menu callback must be a function");
      const listener = (_event, action) => callback(action);
      ipcRenderer.on("arbor:menu-action", listener);
      return () => ipcRenderer.removeListener("arbor:menu-action", listener);
    },
  }),
);
