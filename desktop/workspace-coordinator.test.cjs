"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WorkspaceCoordinator } = require("./workspace-coordinator.cjs");
const { Backend } = require("./backend.cjs");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const { PreferencesStore } = require("./preferences-store.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { scanOptions, validatePreferences } = require("./protocol.cjs");

const row = {
  id: "same-native-id",
  path: "/work/topic",
  head: "a".repeat(40),
  branch: "topic",
  repo: "repo",
  commonDir: "/work/repo/.git",
  canRemove: true,
  recommended: true,
};
const report = (rows = [row]) => ({
  root: "/work",
  worktrees: rows,
  warnings: [],
  scannedAt: "2026-01-01T00:00:00Z",
});
const options = (host) => scanOptions({ host, root: "/work", excludes: [] });
const preferences = (hosts) =>
  validatePreferences({
    setupCompleted: true,
    scan: options(""),
    hosts: hosts.map((host) => ({ host, name: host, root: "/work" })),
  });
const hostOf = (args) =>
  args.includes("--host") ? args[args.indexOf("--host") + 1] : "";
const until = async (condition) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not settle");
};

for (const launch of ["explicit remote", "remote first setup"]) {
  test(`${launch} reopens an inactive local host without scanning it until Refresh`, async () => {
    const calls = [];
    const coordinator = new WorkspaceCoordinator({
      options: options(launch === "explicit remote" ? "vps" : ""),
      sessionHost: launch === "explicit remote" ? "vps" : undefined,
      setupRequired: launch === "remote first setup",
      run: async (args) => {
        calls.push(hostOf(args));
        return JSON.stringify(report());
      },
    });
    if (launch === "explicit remote") await coordinator.start({ host: "vps" });
    else await coordinator.completeSetup(options("vps"), async () => {});
    await coordinator.waitUntilIdle();
    assert.deepEqual(calls, ["vps"]);
    coordinator.requestClose();
    await coordinator.reopen();
    await coordinator.waitUntilIdle();
    assert.deepEqual(
      calls,
      ["vps"],
      "reopen restores only the started remote cache",
    );
    coordinator.refreshHosts("");
    await coordinator.waitUntilIdle();
    assert.deepEqual(
      calls,
      ["vps", ""],
      "local Refresh launches its first scan",
    );
    const local = coordinator.getState().hosts.find((host) => host.host === "");
    assert.equal(local.error, "");
    assert.equal(local.worktreeCount, 1);
  });
}

function controlled(hosts, cached = hosts) {
  const cache = new WorkspaceCache();
  for (const host of cached) cache.put(options(host), report());
  const calls = [],
    scans = new Map();
  const coordinator = new WorkspaceCoordinator({
    options: options(""),
    cache,
    run: (args, callbacks) => {
      const host = hostOf(args);
      calls.push({ host, args });
      if (args[0] === "remove")
        return Promise.resolve(
          JSON.stringify({ path: args.at(-1), removed: true }),
        );
      if (args.includes("--target-only"))
        return Promise.resolve(JSON.stringify(report()));
      return new Promise((resolve, reject) => {
        scans.set(host, {
          resolve: (value) => resolve(JSON.stringify(value || report())),
          reject,
          callbacks,
        });
        callbacks.signal.addEventListener(
          "abort",
          () => reject(new Error("scan stopped")),
          { once: true },
        );
      });
    },
  });
  return {
    coordinator,
    cache,
    calls,
    scans,
    initialize: async () => {
      await coordinator.synchronizeHosts(preferences(hosts.filter(Boolean)));
      await coordinator.start();
    },
  };
}

test("all cached hosts restore immediately with independent global identities and no scan", async () => {
  const fixture = controlled(["", "slow", "fast"]);
  await fixture.initialize();
  const state = fixture.coordinator.getState();
  assert.equal(state.hostFilter, null);
  assert.equal(state.report.worktrees.length, 3);
  assert.equal(new Set(state.report.worktrees.map((row) => row.id)).size, 3);
  assert.equal(fixture.calls.length, 0);
  fixture.coordinator.setHostFilter("slow");
  assert.deepEqual(
    fixture.coordinator.getState().report.worktrees.map((row) => row.host),
    ["slow"],
  );
  fixture.coordinator.setHostFilter(null);
  assert.equal(fixture.calls.length, 0);
  assert.throws(
    () => fixture.coordinator.setHostFilter("unknown"),
    /no longer configured/,
  );
});

test("one slow host keeps cached rows while another host refreshes and cached cleanup remains usable", async () => {
  const fixture = controlled(["", "slow"]);
  await fixture.initialize();
  const before = fixture.coordinator.getState();
  const selected = before.report.worktrees.find((row) => row.host === "");
  fixture.coordinator.refreshHosts(null);
  await until(() => fixture.scans.size === 2);
  assert.equal(fixture.coordinator.getState().report.worktrees.length, 2);
  fixture.scans
    .get("slow")
    .resolve(report([{ ...row, branch: "changed-elsewhere" }]));
  await until(
    () =>
      !fixture.coordinator.getState().hosts.find((host) => host.host === "slow")
        .busy,
  );
  assert.equal(
    fixture.coordinator.resolveWorktree({
      id: selected.id,
      revision: before.revision,
    }).removable,
    true,
  );
  const removed = await fixture.coordinator.remove({
    revision: before.revision,
    recommendedOnly: true,
    items: [{ id: selected.id, head: selected.head }],
  });
  assert.equal(removed.results[0].host, "");
  assert.equal(fixture.scans.get("").callbacks.signal.aborted, true);
  assert.equal(fixture.scans.get("slow").callbacks.signal.aborted, false);
  assert.deepEqual(
    fixture.coordinator.getState().report.worktrees.map((row) => row.host),
    ["slow"],
  );
  assert.deepEqual(
    fixture.calls
      .filter((call) => call.args[0] === "remove")
      .map((call) => call.host),
    [""],
  );
});

test("refresh errors and stopping preserve cached metadata; unchecked partial rows cannot authorize cleanup", async () => {
  const fixture = controlled(["", "slow"]);
  await fixture.initialize();
  fixture.coordinator.refreshHosts(null);
  await until(() => fixture.scans.size === 2);
  fixture.scans.get("").callbacks.onProgress({
    stage: "discovery",
    path: "/work/new",
    discovered: 2,
    completed: 0,
    total: 0,
    worktree: { id: "new", path: "/work/new" },
    pending: true,
  });
  let state = fixture.coordinator.getState();
  const pending = state.report.worktrees.find((row) => row.sourceID === "new");
  assert.equal(pending.pending, true);
  await assert.rejects(
    fixture.coordinator.remove({
      revision: state.revision,
      items: [{ id: pending.id, head: "" }],
    }),
    /protected/,
  );
  fixture.scans.get("slow").reject(new Error("SSH unavailable"));
  fixture.coordinator.cancelScan("");
  await fixture.coordinator.waitUntilIdle();
  state = fixture.coordinator.getState();
  assert.equal(state.report.worktrees.filter((row) => !row.pending).length, 2);
  assert.match(
    state.hosts.find((host) => host.host === "slow").error,
    /SSH unavailable/,
  );
  assert.equal(state.hosts.find((host) => host.host === "").cancelled, true);
});

test("background queue limits scans to three and a fourth configuration returns a stoppable queued state", async () => {
  const fixture = controlled(["", "a", "b", "c"], []);
  await fixture.initialize();
  await until(() => fixture.scans.size === 3);
  let state = fixture.coordinator.getState();
  assert.equal(state.hosts.find((host) => host.host === "c").queued, true);
  assert.equal(
    state.hosts.find((host) => host.host === "c").canCancelScan,
    true,
  );
  let saved = false;
  const queued = await fixture.coordinator.configureWorkspace(
    options("c"),
    async () => {
      saved = true;
    },
  );
  assert.equal(queued.hostFilter, "c");
  assert.equal(queued.hosts.find((host) => host.host === "c").queued, true);
  assert.equal(saved, false);
  fixture.coordinator.cancelScan("c");
  fixture.coordinator.requestClose();
  await fixture.coordinator.waitUntilIdle();
  assert.equal(fixture.scans.has("c"), false);
});

test("forgetting a host stops only its scan and later preference saves preserve per-host scan options", async () => {
  const fixture = controlled(["", "remote"]);
  await fixture.initialize();
  await fixture.coordinator.configureWorkspace(
    { ...options("remote"), excludes: ["custom"], github: true },
    async () => {},
  );
  await until(() => fixture.scans.has("remote"));
  await fixture.coordinator.synchronizeHosts({
    ...preferences(["remote"]),
    theme: "dark",
  });
  assert.deepEqual(
    fixture.coordinator.getState().hosts.find((host) => host.host === "remote")
      .options.excludes,
    ["custom"],
  );
  await fixture.coordinator.synchronizeHosts(preferences([]));
  assert.equal(fixture.scans.get("remote").callbacks.signal.aborted, true);
  assert.deepEqual(
    fixture.coordinator.getState().hosts.map((host) => host.host),
    [""],
  );
  assert.equal(fixture.coordinator.getState().report.worktrees.length, 1);
});

test("multi-host cleanup gets one consent and routes each identical path to its actual host", async () => {
  const fixture = controlled(["", "remote"]);
  await fixture.initialize();
  const state = fixture.coordinator.getState();
  let confirmations = 0;
  const result = await fixture.coordinator.remove(
    {
      revision: state.revision,
      forceConfirm: true,
      items: state.report.worktrees.map(({ id, head }) => ({ id, head })),
    },
    async (rows) => {
      confirmations++;
      assert.deepEqual(
        rows.map((row) => row.host),
        ["", "remote"],
      );
      return true;
    },
  );
  assert.equal(confirmations, 1);
  assert.equal(result.results.length, 2);
  assert.deepEqual(
    fixture.calls.map((call) => call.host),
    ["", "remote"],
  );
  assert.equal(fixture.coordinator.getState().report.worktrees.length, 0);
});

test("a newer close prevents a waiting coordinator reopen from restarting any host", async () => {
  let finish,
    calls = 0;
  const coordinator = new WorkspaceCoordinator({
    options: options(""),
    run: () => {
      calls++;
      return new Promise((resolve) => {
        finish = () => resolve(JSON.stringify(report()));
      });
    },
  });
  await coordinator.start();
  await until(() => !!finish);
  assert.equal(coordinator.requestClose().action, "wait");
  const reopening = coordinator.reopen();
  coordinator.requestClose();
  finish();
  await reopening;
  assert.equal(calls, 1);
  assert.throws(() => coordinator.assertInteractive(), /closing/);
});

test("explicit host startup never scans the implicit local computer", async () => {
  const calls = [];
  const coordinator = new WorkspaceCoordinator({
    options: options("remote"),
    hostFilter: "remote",
    run: async (args) => {
      calls.push(hostOf(args));
      return JSON.stringify(report());
    },
  });
  await coordinator.start({ refresh: true, host: "remote" });
  await coordinator.waitUntilIdle();
  assert.deepEqual(calls, ["remote"]);
  assert.equal(coordinator.getState().hostFilter, "remote");
});

test("normal startup does not resurrect a forgotten host from legacy last-scan preferences", async () => {
  const local = options("");
  const remote = options("forgotten");
  const saved = validatePreferences({
    setupCompleted: true,
    hosts: [],
    scan: remote,
    scans: [local, remote],
  });
  const cache = new WorkspaceCache();
  cache.put(local, report());
  const calls = [];
  const coordinator = new WorkspaceCoordinator({
    options: saved.scan,
    cache,
    run: async (args) => {
      calls.push(hostOf(args));
      return JSON.stringify(report());
    },
  });
  await coordinator.synchronizeHosts(saved);
  await coordinator.start();
  await coordinator.waitUntilIdle();
  assert.deepEqual(
    coordinator.getState().hosts.map((host) => host.host),
    [""],
  );
  assert.deepEqual(calls, []);
});

test("restart restores each host's cache with its own saved exclusion and network options", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "arbor-host-options-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "preferences.json");
  const store = await PreferencesStore.open(filename);
  const local = scanOptions({
    host: "",
    root: "/work",
    excludes: ["local-only"],
    github: false,
    fetch: false,
  });
  const remote = scanOptions({
    host: "remote",
    root: "/work",
    excludes: ["remote-only"],
    github: true,
    fetch: true,
  });
  await store.saveScan(local, { setupCompleted: true });
  await store.saveScan(remote, { setupCompleted: true });
  const saved = (await PreferencesStore.open(filename)).get();
  const cache = new WorkspaceCache();
  cache.put(local, report());
  cache.put(remote, report());
  const calls = [];
  const coordinator = new WorkspaceCoordinator({
    options: saved.scan,
    cache,
    run: async (args) => {
      calls.push(args);
      return JSON.stringify(report());
    },
  });
  await coordinator.synchronizeHosts(saved);
  await coordinator.start();
  await coordinator.waitUntilIdle();
  assert.deepEqual(
    calls,
    [],
    "restoring saved host caches must not rescan with another host's options",
  );
  const hosts = coordinator.getState().hosts;
  assert.deepEqual(hosts.find((host) => host.host === "").options, local);
  assert.deepEqual(
    hosts.find((host) => host.host === "remote").options,
    remote,
  );
});

test("concurrent configurations of one host are explicitly rejected rather than silently dropped", async () => {
  const fixture = controlled([""]);
  await fixture.initialize();
  let finishSave;
  const saving = new Promise((resolve) => {
    finishSave = resolve;
  });
  const writes = [];
  const first = fixture.coordinator.configureWorkspace(
    { ...options(""), root: "/first" },
    async (value) => {
      writes.push(value.root);
      await saving;
    },
  );
  await assert.rejects(
    fixture.coordinator.configureWorkspace(
      { ...options(""), root: "/second" },
      async (value) => {
        writes.push(value.root);
      },
    ),
    /already running/,
  );
  await first;
  fixture.coordinator.cancelScan("");
  finishSave();
  await fixture.coordinator.waitUntilIdle();
  assert.deepEqual(writes, ["/first"]);
  assert.equal(fixture.calls.length, 0);
});

test("queued snapshot options are detached from the settings eventually persisted and scanned", async () => {
  const fixture = controlled(["", "a", "b", "c"], []);
  await fixture.initialize();
  await until(() => fixture.scans.size === 3);
  let saved;
  const queued = await fixture.coordinator.configureWorkspace(
    { ...options("c"), excludes: ["intended"] },
    async (value) => {
      saved = value;
    },
  );
  queued.options.root = "/mutated";
  queued.options.excludes.push("changed");
  queued.hosts
    .find((host) => host.host === "c")
    .options.excludes.push("also changed");
  assert.deepEqual(
    fixture.coordinator.getState().hosts.find((host) => host.host === "c")
      .options.excludes,
    ["intended"],
  );
  fixture.scans.get("").resolve();
  await until(() => !!saved);
  assert.deepEqual(saved.excludes, ["intended"]);
  assert.equal(saved.root, "/work");
  fixture.coordinator.requestClose();
  await fixture.coordinator.waitUntilIdle();
});

test("Stop during pending settings persistence prevents the later scan from launching", async () => {
  const fixture = controlled([""]);
  await fixture.initialize();
  let finishSave;
  const saving = new Promise((resolve) => {
    finishSave = resolve;
  });
  await fixture.coordinator.configureWorkspace(
    { ...options(""), root: "/next" },
    () => saving,
  );
  const pending = fixture.coordinator.getState();
  assert.equal(pending.hosts[0].queued, true);
  assert.equal(pending.hosts[0].canCancelScan, true);
  const stopping = fixture.coordinator.cancelScan("");
  assert.equal(stopping.hosts[0].cancelRequested, true);
  assert.equal(stopping.hosts[0].canCancelScan, false);
  finishSave();
  await fixture.coordinator.waitUntilIdle();
  assert.equal(fixture.calls.length, 0);
  const stopped = fixture.coordinator.getState();
  assert.equal(stopped.busy, false);
  assert.equal(stopped.hosts[0].cancelled, true);
  assert.equal(stopped.report.worktrees.length, 1);
});

test("cancelling a queued draft preserves committed options for Refresh and cached restart", async () => {
  const fixture = controlled(["", "a", "b", "c"]);
  await fixture.initialize();
  fixture.coordinator.refreshHosts(null);
  await until(() => fixture.scans.size === 3);
  let saved = false;
  await fixture.coordinator.configureWorkspace(
    { ...options("c"), root: "/unsaved", excludes: ["unsaved"] },
    async () => {
      saved = true;
    },
  );
  fixture.coordinator.cancelScan("c");
  await new Promise((resolve) => setImmediate(resolve));
  fixture.coordinator.refreshHosts("c");
  fixture.scans.get("").resolve();
  await until(() => fixture.scans.has("c"));
  assert.equal(saved, false);
  const call = fixture.calls.find((call) => call.host === "c");
  assert.equal(call.args[call.args.indexOf("--path") + 1], "/work");
  assert.equal(call.args.includes("unsaved"), false);
  fixture.scans.get("c").resolve();
  fixture.coordinator.cancelScan(null);
  await fixture.coordinator.waitUntilIdle();
  const restartCalls = [];
  const restarted = new WorkspaceCoordinator({
    options: options(""),
    cache: fixture.cache,
    run: async (args) => {
      restartCalls.push(args);
      return JSON.stringify(report());
    },
  });
  await restarted.synchronizeHosts(preferences(["a", "b", "c"]));
  await restarted.start();
  await restarted.waitUntilIdle();
  assert.deepEqual(restartCalls, []);
});

test("setup's first scan occupies a scheduler slot before newly added hosts start", async () => {
  const scans = new Map();
  const coordinator = new WorkspaceCoordinator({
    setupRequired: true,
    options: options(""),
    run: (args, { signal }) =>
      new Promise((resolve, reject) => {
        scans.set(hostOf(args), resolve);
        signal.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        });
      }),
  });
  await coordinator.completeSetup(options(""), async () => {});
  await coordinator.synchronizeHosts(preferences(["a", "b", "c"]));
  await until(() => scans.size === 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    scans.size,
    3,
    "setup cannot run a fourth scan outside the background scheduler",
  );
  assert.equal(
    coordinator.getState().hosts.filter((host) => host.queued).length,
    1,
  );
  coordinator.requestClose();
  await coordinator.waitUntilIdle();
});

test("explicit session-only hosts survive theme saves but become forgettable once saved", async () => {
  let signal;
  const coordinator = new WorkspaceCoordinator({
    options: options("adhoc"),
    hostFilter: "adhoc",
    sessionHost: "adhoc",
    run: (_args, callbacks) =>
      new Promise((_resolve, reject) => {
        signal = callbacks.signal;
        signal.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        });
      }),
  });
  await coordinator.start({ host: "adhoc", refresh: true });
  await until(() => !!signal);
  await coordinator.synchronizeHosts({ ...preferences([]), theme: "dark" });
  assert.equal(
    coordinator.getState().hosts.some((host) => host.host === "adhoc"),
    true,
  );
  assert.equal(signal.aborted, false);
  await coordinator.synchronizeHosts(preferences(["adhoc"]));
  await coordinator.synchronizeHosts(preferences([]));
  assert.equal(signal.aborted, true);
  assert.equal(
    coordinator.getState().hosts.some((host) => host.host === "adhoc"),
    false,
  );
});

test("a later host-level cleanup failure preserves earlier verified successes", async () => {
  const cache = new WorkspaceCache();
  for (const host of ["", "remote"]) cache.put(options(host), report());
  class FailingRemoteBackend extends Backend {
    remove(...args) {
      if (this.getState().host === "remote")
        throw new Error("Remote operation could not begin");
      return super.remove(...args);
    }
  }
  const coordinator = new WorkspaceCoordinator({
    cache,
    options: options(""),
    backendFactory: (options) => new FailingRemoteBackend(options),
    run: async (args) => JSON.stringify({ path: args.at(-1), removed: true }),
  });
  await coordinator.synchronizeHosts(preferences(["remote"]));
  await coordinator.start();
  const state = coordinator.getState();
  const result = await coordinator.remove({
    revision: state.revision,
    recommendedOnly: true,
    items: state.report.worktrees.map(({ id, head }) => ({ id, head })),
  });
  assert.deepEqual(result.results, [
    { host: "", path: row.path, removed: true },
    {
      host: "remote",
      path: row.path,
      removed: false,
      error: "Remote operation could not begin",
    },
  ]);
  assert.deepEqual(
    coordinator.getState().report.worktrees.map((row) => row.host),
    ["remote"],
  );
  assert.equal(coordinator.getState().removing, false);
});

test("declining removal leaves affected and unrelated refreshes running, and inspection cannot race consent", async () => {
  const fixture = controlled(["", "remote"]);
  await fixture.initialize();
  fixture.coordinator.refreshHosts(null);
  await until(() => fixture.scans.size === 2);
  const state = fixture.coordinator.getState();
  const selected = state.report.worktrees.find((row) => row.host === "");
  let decide;
  const cleanup = fixture.coordinator.remove(
    {
      revision: state.revision,
      forceConfirm: true,
      items: [{ id: selected.id, head: selected.head }],
    },
    () =>
      new Promise((resolve) => {
        decide = resolve;
      }),
  );
  assert.equal(fixture.scans.get("").callbacks.signal.aborted, false);
  assert.equal(fixture.scans.get("remote").callbacks.signal.aborted, false);
  assert.throws(
    () =>
      fixture.coordinator.inspectWorktree({
        id: selected.id,
        revision: state.revision,
      }),
    /Cleanup is running/,
  );
  decide(false);
  assert.equal((await cleanup).cancelled, true);
  assert.equal(fixture.scans.get("").callbacks.signal.aborted, false);
  assert.equal(fixture.scans.get("remote").callbacks.signal.aborted, false);
  assert.equal(
    fixture.calls.some((call) => call.args[0] === "remove"),
    false,
  );
  fixture.coordinator.cancelScan(null);
  await fixture.coordinator.waitUntilIdle();
});

test("approval revalidates a host whose scan completed while the native consent was open", async () => {
  const fixture = controlled([""]);
  await fixture.initialize();
  fixture.coordinator.refreshHosts("");
  await until(() => fixture.scans.has(""));
  const state = fixture.coordinator.getState();
  const selected = state.report.worktrees[0];
  let decide;
  const cleanup = fixture.coordinator.remove(
    {
      revision: state.revision,
      forceConfirm: true,
      items: [{ id: selected.id, head: selected.head }],
    },
    () =>
      new Promise((resolve) => {
        decide = resolve;
      }),
  );
  fixture.scans.get("").resolve();
  await until(() => !fixture.coordinator.getState().hosts[0].busy);
  decide(true);
  await assert.rejects(cleanup, /scan changed/);
  assert.equal(
    fixture.calls.some((call) => call.args[0] === "remove"),
    false,
  );
});

test("a selection as large as a scan is removed in one confirmed cleanup", async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => ({
    ...row,
    id: `row-${index}`,
    path: `/work/topic-${index}`,
  }));
  const removed = [];
  const coordinator = new WorkspaceCoordinator({
    options: options(""),
    run: async (args) => {
      if (args[0] !== "remove") return JSON.stringify(report(rows));
      removed.push(args.at(-1));
      return JSON.stringify({ path: args.at(-1), removed: true });
    },
  });
  await coordinator.start();
  await coordinator.waitUntilIdle();
  const state = coordinator.getState();
  assert.equal(state.report.worktrees.length, 1001);
  const selection = (items) => ({
    revision: state.revision,
    recommendedOnly: true,
    items,
  });
  await assert.rejects(
    coordinator.remove(selection([])),
    /Choose at least one worktree/,
  );
  const result = await coordinator.remove(
    selection(state.report.worktrees.map(({ id, head }) => ({ id, head }))),
  );
  assert.equal(result.results.length, 1001);
  assert.equal(removed.length, 1001);
  assert.equal(result.report.worktrees.length, 0);
});
