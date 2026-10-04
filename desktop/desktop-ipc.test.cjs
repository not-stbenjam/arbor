"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerDesktopIPC } = require("./desktop-ipc.cjs");

function adapter({ backend = {}, preferences = {}, dialog = {} } = {}) {
  const handlers = new Map();
  const rendererURL = "file:///arbor/renderer/index.html";
  const window = { webContents: { mainFrame: { url: rendererURL } } };
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const controller = registerDesktopIPC({
    app: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog,
    shell: {},
    clipboard: {},
    backend,
    preferences,
    getWindow: () => window,
    rendererURL,
    showWorktreeMenu: () => true,
  });
  return {
    call: (name, ...args) => handlers.get(`arbor:${name}`)(event, ...args),
    handlers,
    event,
    controller,
  };
}

test("desktop IPC accepts only the current renderer main frame", () => {
  const { call, handlers, event } = adapter({
    backend: { getState: () => ({ busy: false }) },
  });
  assert.deepEqual(call("get-state"), { busy: false });
  const handler = handlers.get("arbor:get-state");
  assert.throws(() => handler({ ...event, sender: {} }), /Unrecognized/);
  assert.throws(
    () => handler({ ...event, senderFrame: { ...event.senderFrame } }),
    /Unrecognized/,
  );
  event.senderFrame.url = "https://example.invalid";
  assert.throws(() => handler(event), /Unrecognized/);
});

test("scan, activate and setup each delegate one canonical persistence callback with appearance", async () => {
  const writes = [],
    starts = [];
  const backend = {
    configureWorkspace: async (value, persist, options) => {
      starts.push([value, options]);
      await persist({ root: value.root, excludes: [] });
      return { busy: true };
    },
    completeSetup: async (value, persist) => {
      starts.push([value, "setup"]);
      await persist({ root: value.root, host: value.host, excludes: [] });
      return { busy: true };
    },
  };
  const preferences = {
    saveScan: async (value, options) => {
      writes.push([value, options]);
    },
  };
  const { call } = adapter({ backend, preferences });
  for (const name of ["scan", "activate-workspace", "complete-setup"])
    await call(name, { root: "/projects", host: "vps", theme: "dark" });
  assert.equal(starts.length, 3);
  assert.equal(writes.length, 3);
  assert.deepEqual(starts[1][1], { restore: true });
  assert.deepEqual(
    writes.map(([, options]) => options),
    [
      { theme: "dark" },
      { theme: "dark" },
      { setupCompleted: true, theme: "dark" },
    ],
  );
});

test("native cleanup consent is abortable and released after the dialog settles", async () => {
  let finish;
  const backend = {
    assertInteractive() {},
    async remove(_selection, confirm) {
      return {
        cancelled: !(await confirm([{ path: "/work/topic", canRemove: true }], {
          discardLocal: false,
        })),
      };
    },
  };
  const dialog = {
    showMessageBox: (_window, options) =>
      new Promise((resolve) => {
        finish = resolve;
        assert.equal(options.signal.aborted, false);
      }),
  };
  const { call, controller } = adapter({ backend, dialog });
  const pending = call("remove", {});
  assert.ok(controller.getRemovalConfirmation() instanceof AbortController);
  controller.getRemovalConfirmation().abort();
  finish({ response: 0 });
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(controller.getRemovalConfirmation(), null);
});
