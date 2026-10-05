"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { WorkspaceCoordinator } = require("./workspace-coordinator.cjs");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const { scanOptions } = require("./protocol.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tree = {
  id: "tree-1",
  path: "/work/topic",
  head: "a".repeat(40),
  branch: "topic",
  repo: "repo",
  canRemove: true,
  recommended: true,
  outsideRoot: false,
};
const report = (trees = [tree], root = "/work") =>
  JSON.stringify({ root, worktrees: trees, warnings: [] });
const options = { root: "/work", excludes: [] };
const selection = (backend, changes = {}) => ({
  items: backend
    .getState()
    .report.worktrees.map(({ id, head }) => ({ id, head })),
  recommendedOnly: true,
  revision: backend.getState().revision,
  ...changes,
});

test("setup owns persistence and close cannot launch a subprocess after saving", async () => {
  const saved = deferred();
  let calls = 0;
  const backend = new WorkspaceCoordinator({
    setupRequired: true,
    run: async () => {
      calls++;
      return report();
    },
  });
  assert.equal((await backend.start()).setupRequired, true);
  const setup = backend.completeSetup(options, async (value) => {
    assert.equal(value.root, "/work");
    value.root = "/mutated-copy";
    await saved.promise;
  });
  await assert.rejects(
    backend.configureWorkspace(options, async () => {}),
    /already running/,
  );
  await assert.rejects(
    backend.completeSetup(options, async () => {}),
    /already running/,
  );
  assert.deepEqual(backend.requestClose(), { action: "wait" });
  saved.resolve();
  await setup;
  await backend.waitUntilIdle();
  assert.equal(calls, 0);
  assert.equal(backend.getState().setupRequired, false);
  assert.throws(() => backend.assertInteractive(), /closing/);
  await backend.reopen();
  await backend.waitUntilIdle();
  assert.equal(calls, 1);
  assert.equal(backend.getState().options.root, "/work");
  assert.equal(backend.state, undefined);
  assert.equal(backend.operation, undefined);
  assert.equal(backend.pending, undefined);
});

test("failed setup persistence releases ownership and leaves the wizard required", async () => {
  const backend = new WorkspaceCoordinator({
    setupRequired: true,
    run: async () => report(),
  });
  await assert.rejects(
    backend.completeSetup(options, async () => {
      throw new Error("disk full");
    }),
    /disk full/,
  );
  assert.equal(backend.getState().setupRequired, true);
  assert.equal(backend.getState().busy, false);
  await backend.completeSetup(options, async () => {});
  await backend.waitUntilIdle();
  assert.equal(backend.getState().setupRequired, false);
  assert.ok(backend.getState().report);
});

test("cancelling reset preserves a running scan and its existing workspace", async () => {
  const scan = deferred(),
    confirmation = deferred();
  let aborted = false,
    persisted = false;
  const backend = new WorkspaceCoordinator({
    run: (_args, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return scan.promise;
    },
  });
  await backend.configureWorkspace(options, async () => {});
  await tick();
  const reset = backend.resetPreferences(
    () => confirmation.promise,
    async () => {
      persisted = true;
    },
  );
  await assert.rejects(
    backend.configureWorkspace(options, async () => {}),
    /already running/,
  );
  confirmation.resolve(false);
  assert.equal((await reset).cancelled, true);
  assert.equal(aborted, false);
  assert.equal(persisted, false);
  assert.equal(backend.getState().busy, true);
  scan.resolve(report());
  await backend.waitUntilIdle();
  assert.equal(backend.getState().report.worktrees.length, 1);
});

test("four-host reset preserves scans on Cancel and drains three active scans without starting the queued host", async (t) => {
  const started = [],
    aborted = [];
  const backend = new WorkspaceCoordinator({
    options,
    run: (args, { signal }) => {
      const host = args.includes("--host")
        ? args[args.indexOf("--host") + 1]
        : "";
      started.push(host);
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted.push(host);
            reject(new Error("stopped"));
          },
          { once: true },
        ),
      );
    },
  });
  t.after(async () => {
    backend.requestClose();
    await backend.waitUntilIdle();
  });
  await backend.synchronizeHosts({
    setupCompleted: true,
    scan: options,
    hosts: ["one", "two", "queued"].map((host) => ({
      host,
      name: host,
      root: "/work",
    })),
  });
  await backend.start();
  for (let i = 0; i < 100 && started.length < 3; i++) await tick();
  assert.equal(started.length, 3);
  assert.equal(
    backend.getState().hosts.find((host) => host.host === "queued").queued,
    true,
  );
  let writes = 0;
  assert.equal(
    (
      await backend.resetPreferences(
        async () => false,
        async () => {
          writes++;
        },
      )
    ).cancelled,
    true,
  );
  assert.equal(writes, 0);
  assert.deepEqual(aborted, []);
  assert.equal(backend.getState().hosts.filter((host) => host.busy).length, 4);
  const result = await backend.resetPreferences(
    async () => true,
    async () => {
      assert.equal(
        aborted.length,
        3,
        "active subprocesses settle before resetting preferences",
      );
      writes++;
    },
  );
  assert.equal(writes, 1);
  assert.equal(result.state.setupRequired, true);
  assert.equal(result.state.report, null);
  assert.equal(result.state.hosts.length, 1);
  assert.equal(result.state.busy, false);
  assert.equal(
    started.length,
    3,
    "reset never starts the queued fourth host or a replacement scan",
  );
});

test("confirmed reset stops a scan, persists before clearing, and reopens setup without rescanning", async () => {
  const saving = deferred(),
    saveStarted = deferred();
  let calls = 0,
    aborted = false;
  const backend = new WorkspaceCoordinator({
    run: (_args, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("stopped"));
        }),
      );
    },
  });
  await backend.configureWorkspace(options, async () => {});
  await tick();
  const reset = backend.resetPreferences(
    async () => true,
    async () => {
      assert.equal(aborted, true);
      saveStarted.resolve();
      await saving.promise;
    },
  );
  await saveStarted.promise;
  await assert.rejects(
    backend.configureWorkspace(options, async () => {}),
    /already running/,
  );
  assert.deepEqual(backend.requestClose(), { action: "wait" });
  saving.resolve();
  const result = await reset;
  assert.equal(result.cancelled, false);
  assert.equal(result.state.setupRequired, true);
  assert.equal(result.state.report, null);
  await backend.reopen();
  assert.doesNotThrow(() => backend.assertInteractive());
  assert.equal(backend.getState().setupRequired, true);
  assert.equal(calls, 1);
});

test("closing during reset confirmation cancels native consent instead of stranding shutdown", async () => {
  const backend = new WorkspaceCoordinator({ run: async () => report() });
  let saved = false;
  const reset = backend.resetPreferences(
    (signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(false)),
      ),
    async () => {
      saved = true;
    },
  );
  assert.deepEqual(backend.requestClose(), { action: "wait" });
  await backend.waitUntilIdle();
  assert.equal((await reset).cancelled, true);
  assert.equal(saved, false);
  assert.throws(() => backend.assertInteractive(), /closing/);
});

test("first launch cannot scan until setup is completed", async () => {
  let calls = 0;
  const backend = new WorkspaceCoordinator({
    setupRequired: true,
    run: () => {
      calls++;
    },
  });
  assert.equal(backend.getState().setupRequired, true);
  assert.equal(backend.getState().progress, null);
  await assert.rejects(
    backend.configureWorkspace({}, async () => {}),
    /Complete setup/,
  );
  assert.equal(calls, 0);
});

test("reset returns to first launch defaults without scanning or deleting worktrees", async () => {
  const calls = [];
  const cache = new WorkspaceCache();
  const backend = new WorkspaceCoordinator({
    cache,
    version: "v1.2.3",
    platform: "darwin",
    githubAvailable: true,
    run: async (args) => {
      calls.push(args);
      if (args.includes("--target-only"))
        throw new Error("inspection unavailable");
      return report();
    },
  });
  await backend.configureWorkspace(
    {
      root: "~/other",
      host: "vps",
      github: true,
      fetch: true,
      excludes: [],
    },
    async () => {},
  );
  await backend.waitUntilIdle();
  backend.inspectWorktree({
    id: backend.getState().report.worktrees[0].id,
    revision: backend.getState().revision,
  });
  await backend.waitUntilIdle();
  assert.match(backend.getState().error, /inspection unavailable/);
  cache.put(
    scanOptions({ host: "untouched", root: "/work" }),
    JSON.parse(report()),
  );
  assert.ok(cache.entries.size > 0);
  const previousRevision = backend.getState().revision;
  const { state: reset } = await backend.resetPreferences(
    async () => true,
    async () => {},
  );
  assert.equal(reset.setupRequired, true);
  assert.equal(reset.busy, false);
  assert.equal(reset.report, null);
  assert.equal(reset.hosts[0].revision, null);
  assert.notEqual(reset.revision, previousRevision);
  assert.equal(cache.entries.size, 0);
  assert.equal(reset.progress, null);
  assert.equal(reset.error, "");
  assert.equal(reset.root, "");
  assert.equal(reset.host, "");
  assert.equal(reset.cancelled, false);
  assert.equal(reset.canCancelScan, false);
  assert.equal(reset.version, "v1.2.3");
  assert.equal(reset.platform, "darwin");
  assert.equal(reset.githubAvailable, true);
  assert.equal(reset.worktreeCount, 0);
  assert.deepEqual(reset.options, scanOptions());
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "list");
  assert.ok(calls[1].includes("--target-only"));
  await assert.rejects(
    backend.configureWorkspace({}, async () => {}),
    /Complete setup/,
  );
  assert.equal(calls.length, 2);
  reset.options.excludes.push("should not change state");
  assert.deepEqual(backend.getState().options, scanOptions());
});

test("confirmed reset cancels an active scan and waits before clearing partial state", async () => {
  let finish, callbacks;
  const backend = new WorkspaceCoordinator({
    run: (_args, options) => {
      callbacks = options;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await tick();
  callbacks.onProgress({
    stage: "inspect",
    path: tree.path,
    discovered: 1,
    completed: 1,
    total: 1,
    worktree: tree,
    pending: false,
  });
  let persisted = false;
  const resetting = backend.resetPreferences(
    async () => true,
    async () => {
      persisted = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.signal.aborted, true);
  assert.equal(
    persisted,
    false,
    "reset must await scan completion before persisting",
  );
  assert.equal(backend.getState().report.worktrees.length, 1);
  finish(report());
  const { state: reset } = await resetting;
  assert.equal(persisted, true);
  assert.equal(reset.cancelled, false);
  assert.equal(reset.worktreeCount, 0);
  assert.equal(reset.progress, null);
  assert.equal(reset.setupRequired, true);
});

test("reset refuses cleanup and closing state", async () => {
  const calls = [];
  const backend = new WorkspaceCoordinator({
    run: async (args) => {
      calls.push(args);
      return report([{ ...tree, recommended: false }]);
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await tick();
  await backend.waitUntilIdle();
  let confirm;
  const pending = backend.remove(
    selection(backend, { recommendedOnly: false }),
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  let resetConfirmed = false;
  assert.throws(
    () =>
      backend.resetPreferences(
        async () => {
          resetConfirmed = true;
          return true;
        },
        async () => {},
      ),
    /cleanup to finish/,
  );
  assert.equal(
    resetConfirmed,
    false,
    "cleanup blocks reset before confirmation or persistence",
  );
  await tick();
  confirm(false);
  await pending;
  assert.equal(calls.length, 1);
  backend.requestClose();
  assert.throws(
    () =>
      backend.resetPreferences(
        async () => true,
        async () => {},
      ),
    /closing/,
  );
});
