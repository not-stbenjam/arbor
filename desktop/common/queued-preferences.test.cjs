"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

async function fixture(onAccepted = () => {}) {
  const { createWorkspaceController } = await import(
    "../renderer/workspace-controller.mjs"
  );
  let state = {
    host: "",
    hostFilter: "",
    hosts: [{ host: "", busy: false }],
    busy: false,
    report: { worktrees: [] },
  };
  const callbacks = [],
    timers = new Map();
  let timerID = 0;
  const api = {
    async getState() {
      return state;
    },
    async scan(options) {
      state = {
        ...state,
        host: options.host,
        hostFilter: options.host,
        busy: true,
        hosts: [
          ...state.hosts.filter((source) => source.host !== options.host),
          { host: options.host, queued: true, busy: true, options },
        ],
      };
      return state;
    },
    async setHostFilter(hostFilter) {
      state = { ...state, hostFilter, host: hostFilter || "" };
      return state;
    },
    async resetPreferences() {
      state = {
        host: "",
        hostFilter: "",
        hosts: [],
        busy: false,
        setupRequired: true,
        report: null,
      };
      return { state, preferences: {} };
    },
  };
  const workspace = createWorkspaceController({
    api,
    linked: (rows) => rows,
    notify() {},
    onChange() {},
    onSetup() {},
    onHostChange() {},
    onReset() {},
    onScanAccepted(options) {
      callbacks.push(options);
      return onAccepted(options);
    },
    timers: {
      setTimeout(fn) {
        timers.set(++timerID, fn);
        return timerID;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  });
  await workspace.initialize();
  return {
    workspace,
    api,
    callbacks,
    timers,
    settleHost(host, extra = {}) {
      state = {
        ...state,
        hosts: state.hosts.map((source) =>
          source.host === host
            ? { ...source, queued: false, ...extra }
            : source,
        ),
      };
    },
    async poll() {
      const [id, fn] = timers.entries().next().value;
      timers.delete(id);
      await fn();
    },
  };
}

test("queued scan reloads preferences only after persistence settles and never blocks filtering or polling", async () => {
  let finishReload;
  const reload = new Promise((resolve) => {
    finishReload = resolve;
  });
  const f = await fixture(() => reload);
  const options = {
    host: "queued-vps",
    root: "/requested",
    theme: "dark",
    excludes: ["new-cache"],
  };
  await f.workspace.scan(options);
  assert.deepEqual(
    f.callbacks,
    [],
    "do not reload old preferences while scheduler/persistence is pending",
  );
  await f.poll();
  assert.deepEqual(f.callbacks, []);
  await f.workspace.setHostFilter(null);
  assert.equal(f.workspace.snapshot.hostFilter, null);
  f.settleHost("queued-vps", { busy: true });
  await f.poll();
  assert.deepEqual(f.callbacks, [options]);
  assert.equal(
    f.workspace.snapshot.hostFilter,
    null,
    "late scan acceptance must not restore its original filter",
  );
  assert.equal(
    f.timers.size,
    1,
    "next poll is scheduled before preferences reload finishes",
  );
  await f.workspace.setHostFilter("");
  await f.poll();
  assert.equal(f.callbacks.length, 1, "each queued acceptance reloads once");
  assert.equal(f.workspace.snapshot.hostFilter, "");
  finishReload();
  await Promise.resolve();
  f.workspace.dispose();
});

test("cancellation and errors settle queued preferences without requiring a successful scan", async () => {
  for (const completion of [
    { cancelled: true, busy: false },
    { error: "Could not start", busy: false },
  ]) {
    const f = await fixture();
    await f.workspace.scan({ host: "vps", root: "/queued" });
    f.settleHost("vps", completion);
    await f.poll();
    assert.equal(f.callbacks.length, 1);
    await f.poll();
    assert.equal(f.callbacks.length, 1);
    f.workspace.dispose();
  }
});

test("reset and disposal discard queued preference reloads", async () => {
  const reset = await fixture();
  await reset.workspace.scan({ host: "vps", root: "/queued" });
  await reset.workspace.reset();
  await reset.poll();
  assert.deepEqual(reset.callbacks, []);
  reset.workspace.dispose();

  const disposed = await fixture();
  await disposed.workspace.scan({ host: "vps", root: "/queued" });
  let finishState;
  disposed.api.getState = () =>
    new Promise((resolve) => {
      finishState = resolve;
    });
  const pendingPoll = disposed.poll();
  disposed.workspace.dispose();
  finishState({ hostFilter: "vps", hosts: [{ host: "vps", queued: false }] });
  await pendingPoll;
  assert.deepEqual(disposed.callbacks, []);
  assert.equal(disposed.timers.size, 0);
});
