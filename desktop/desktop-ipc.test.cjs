"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerDesktopIPC } = require("./desktop-ipc.cjs");

function adapter({ backend = {}, preferences = {}, dialog = {}, app = {}, ...rest } = {}) {
  const handlers = new Map();
  const rendererURL = "file:///arbor/renderer/index.html";
  const window = { webContents: { mainFrame: { url: rendererURL } } };
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const controller = registerDesktopIPC({
    app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog,
    backend,
    preferences,
    getWindow: () => window,
    rendererURL,
    showWorktreeMenu: () => true,
    ...rest,
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

test("the renderer bridge exposes only channels the interface uses", () => {
  const { handlers } = adapter();
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      "arbor:cancel-scan",
      "arbor:choose-folder",
      "arbor:complete-setup",
      "arbor:get-defaults",
      "arbor:get-preferences",
      "arbor:get-state",
      "arbor:get-stats",
      "arbor:list-deletions",
      "arbor:menu-availability",
      "arbor:refresh-hosts",
      "arbor:remove",
      "arbor:reset-preferences",
      "arbor:restore",
      "arbor:save-preferences",
      "arbor:save-view",
      "arbor:scan",
      "arbor:set-host-filter",
      "arbor:stop-removal",
      "arbor:worktree-files",
      "arbor:worktree-menu",
    ],
  );
});

test("the folder picker opens at this computer's scan folder, whichever machine is shown", async () => {
  const opened = [];
  const dialog = {
    showOpenDialog: async (_window, options) => {
      opened.push(options.defaultPath);
      return { canceled: false, filePaths: ["/chosen"] };
    },
  };
  const app = { getPath: () => "/home/user" };
  const hosts = [
    { host: "", root: "/projects" },
    { host: "vps", root: "/srv/code" },
  ];
  // The combined view has no folder of its own; a remote view shows another
  // machine's. Neither may become the place a local picker opens.
  for (const state of [
    { hostFilter: null, host: "", root: "", hosts },
    { hostFilter: "vps", host: "vps", root: "/srv/code", hosts },
    { hostFilter: "", host: "", root: "/projects", hosts },
  ]) {
    const { call } = adapter({ backend: { getState: () => state }, dialog, app });
    assert.equal(await call("choose-folder"), "/chosen");
  }
  const { call } = adapter({
    backend: { getState: () => ({ hosts: [{ host: "", root: "" }] }) },
    dialog,
    app,
  });
  await call("choose-folder");
  assert.deepEqual(opened, [
    "/projects",
    "/projects",
    "/projects",
    "/home/user",
  ]);
});

test("scan and setup each delegate one canonical persistence callback with appearance", async () => {
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
  const { call, handlers } = adapter({ backend, preferences });
  assert.equal(handlers.has("arbor:activate-workspace"), false);
  for (const name of ["scan", "complete-setup"])
    await call(name, { root: "/projects", host: "vps", theme: "dark" });
  assert.equal(starts.length, 2);
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map(([, options]) => options),
    [{ theme: "dark" }, { setupCompleted: true, theme: "dark" }],
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

test("host-aware IPC preserves explicit All, local, remote and omitted targets", async () => {
  const calls = [],
    guards = [],
    savedViews = [];
  const { call } = adapter({
    backend: {
      assertInteractive() {
        guards.push("guard");
      },
      readStats: (host) => {
        calls.push(["stats", host]);
        return { host };
      },
      setHostFilter: (host) => {
        calls.push(["filter", host]);
        return { hostFilter: host };
      },
      refreshHosts: (host) => {
        calls.push(["refresh", host]);
        return { refreshed: host };
      },
      cancelScan: (host) => {
        calls.push(["stop", host]);
        return { stopped: host };
      },
      configureWorkspace() {
        assert.fail("host navigation must not configure/start a scan");
      },
    },
    preferences: { saveView: async (value) => savedViews.push(value) },
  });
  for (const host of [null, "", "build-vps", undefined]) {
    assert.deepEqual(await call("get-stats", host), { host });
    assert.deepEqual(await call("set-host-filter", host), { hostFilter: host });
    assert.deepEqual(await call("refresh-hosts", host), { refreshed: host });
    assert.deepEqual(await call("cancel-scan", host), { stopped: host });
  }
  assert.deepEqual(
    calls,
    [null, "", "build-vps", undefined].flatMap((host) => [
      ["stats", host],
      ["filter", host],
      ["refresh", host],
      ["stop", host],
    ]),
  );
  assert.deepEqual(savedViews, [null, "", "build-vps", undefined].map((hostFilter) => ({ hostFilter })));
  assert.equal(guards.length, 4, "stop requests retain the interaction guard");
});

test("saved host preferences synchronize canonical hosts only after durable save completes", async () => {
  let finishSave, finishSync;
  const calls = [];
  const requested = { hosts: [{ host: "vps", name: "Build server" }] };
  const saved = { ...requested, scan: { root: "/canonical" } };
  const { call } = adapter({
    preferences: {
      saveEditable(value) {
        calls.push(["save", value]);
        return new Promise((resolve) => {
          finishSave = resolve;
        });
      },
    },
    backend: {
      assertInteractive() {
        calls.push(["guard"]);
      },
      synchronizeHosts(value) {
        calls.push(["sync", value]);
        return new Promise((resolve) => {
          finishSync = resolve;
        });
      },
    },
  });
  let settled = false;
  const pending = call("save-preferences", requested).then((result) => {
    settled = true;
    return result;
  });
  assert.deepEqual(calls, [["guard"], ["save", requested]]);
  assert.equal(settled, false);
  finishSave(saved);
  await Promise.resolve();
  assert.deepEqual(
    calls.at(-1),
    ["sync", saved],
    "coordinator receives validated/canonical saved preferences, not raw input",
  );
  assert.equal(settled, false, "IPC must await host synchronization");
  finishSync();
  assert.deepEqual(await pending, saved);
});

test("failed preference saves never change configured hosts, and untrusted host IPC never reaches backend", async () => {
  const { call, handlers, event } = adapter({
    preferences: {
      async saveEditable() {
        throw new Error("read-only profile");
      },
    },
    backend: {
      assertInteractive() {},
      synchronizeHosts() {
        assert.fail("failed save cannot synchronize hosts");
      },
      readStats() {
        assert.fail("untrusted stats request");
      },
      setHostFilter() {
        assert.fail("untrusted filter request");
      },
      refreshHosts() {
        assert.fail("untrusted refresh request");
      },
      cancelScan() {
        assert.fail("untrusted stop request");
      },
    },
  });
  await assert.rejects(
    call("save-preferences", { hosts: [] }),
    /read-only profile/,
  );
  for (const name of [
    "get-stats",
    "set-host-filter",
    "refresh-hosts",
    "cancel-scan",
    "save-preferences",
  ])
    assert.throws(
      () => handlers.get(`arbor:${name}`)({ ...event, sender: {} }, null),
      /Unrecognized application window/,
    );
});

test("a folder on this computer that is not there is refused before it is saved", async () => {
  const scans = [], saved = [];
  const missing = Object.assign(new Error("no such file"), { code: "ENOENT" });
  const disk = {
    "/work/code": { isDirectory: () => true },
    "/work/notes.txt": { isDirectory: () => false },
  };
  const { call } = adapter({
    backend: {
      configureWorkspace: async (options) => (scans.push(options.root), {}),
      completeSetup: async (options) => (scans.push(options.root), {}),
    },
    preferences: { saveScan: async (scan) => saved.push(scan) },
    stat: async (folder) => {
      if (folder === "/locked") throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (!disk[folder]) throw missing;
      return disk[folder];
    },
  });
  for (const channel of ["scan", "complete-setup"]) {
    await assert.rejects(
      call(channel, { root: "/work/typo" }),
      /That folder does not exist: \/work\/typo/,
    );
    await assert.rejects(
      call(channel, { root: "/work/notes.txt" }),
      /That is a file, not a folder/,
    );
  }
  assert.deepEqual(scans, [], "nothing was scanned or saved for a folder that is not there");
  assert.deepEqual(saved, []);
  // One that is there goes on, and so does one only the scan can judge: a
  // folder on a host, and one this process may not look at.
  await call("scan", { root: "/work/code" });
  await call("scan", { root: "/anywhere", host: "build-box" });
  await call("scan", { root: "/locked" });
  await call("complete-setup", { root: "/work/code" });
  assert.deepEqual(scans, ["/work/code", "/anywhere", "/locked", "/work/code"]);
});

test("the window says which menu commands can be used", () => {
  const { setMenuAvailability } = require("./application-menu.cjs");
  const items = Object.fromEntries(
    ["refresh", "add-host", "statistics", "settings", "focus-search", "shortcuts", "quit"].map((id) => [id, { enabled: true }]),
  );
  const Menu = { getApplicationMenu: () => ({ getMenuItemById: (id) => items[id] }) };
  const { call } = adapter({ setMenuAvailability: (value) => setMenuAvailability(Menu, value) });
  assert.equal(call("menu-availability", { refresh: false, settings: true, quit: false }), true);
  // Only Arbor's own commands are touched, and only `true` enables one.
  assert.deepEqual(
    Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.enabled])),
    { refresh: false, "add-host": false, statistics: false, settings: true, "focus-search": false, shortcuts: false, quit: true },
  );
  assert.throws(() => call("menu-availability", null), /Invalid menu state/);
  assert.throws(() => call("menu-availability", ["refresh"]), /Invalid menu state/);
});
