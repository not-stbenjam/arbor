"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "arbor",
  Object.freeze({
    getState: () => ipcRenderer.invoke("arbor:get-state"),
    scan: (options) => ipcRenderer.invoke("arbor:scan", options),
    completeSetup: (options) =>
      ipcRenderer.invoke("arbor:complete-setup", options),
    cancelScan: () => ipcRenderer.invoke("arbor:cancel-scan"),
    remove: (selection) => ipcRenderer.invoke("arbor:remove", selection),
    chooseFolder: () => ipcRenderer.invoke("arbor:choose-folder"),
    getPreferences: () => ipcRenderer.invoke("arbor:get-preferences"),
    savePreferences: (preferences) =>
      ipcRenderer.invoke("arbor:save-preferences", preferences),
    openExternal: (url) => ipcRenderer.invoke("arbor:open-external", url),
    copyText: (text) => ipcRenderer.invoke("arbor:copy-text", text),
    onMenuAction: (callback) => {
      if (typeof callback !== "function")
        throw new TypeError("Menu callback must be a function");
      const listener = (_event, action) => callback(action);
      ipcRenderer.on("arbor:menu-action", listener);
      return () => ipcRenderer.removeListener("arbor:menu-action", listener);
    },
  }),
);
