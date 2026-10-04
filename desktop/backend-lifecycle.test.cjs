"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Backend } = require("./backend.cjs");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const row = {
  id: "one",
  path: "/work/one",
  head: "a".repeat(40),
  branch: "topic",
  canRemove: true,
  recommended: true,
};
const report = (rows = [row]) =>
  JSON.stringify({ root: "/work", worktrees: rows, warnings: [] });
const options = { root: "/work", excludes: [] };

test("workspace configuration persists once before scanning and restores without another scan", async () => {
  const saved = deferred();
  let calls = 0,
    writes = 0;
  const backend = new Backend({
    run: async () => {
      calls++;
      return report();
    },
  });
  const configuring = backend.configureWorkspace(options, async (value) => {
    writes++;
    assert.deepEqual(value.excludes, []);
    value.root = "/mutated-copy";
    await saved.promise;
  });
  assert.equal(calls, 0);
  assert.throws(() => backend.scan(options), /already running/);
  saved.resolve();
  await configuring;
  await backend.waitUntilIdle();
  assert.equal(calls, 1);
  assert.equal(writes, 1);
  assert.equal(backend.getState().root, "/work");
  await backend.configureWorkspace(
    options,
    async () => {
      writes++;
    },
    { restore: true },
  );
  assert.equal(writes, 2);
  assert.equal(calls, 1, "workspace restore never triggers a healthy rescan");
});

test("failed workspace persistence leaves the current snapshot and scan options unchanged", async () => {
  let calls = 0;
  const backend = new Backend({
    run: async () => {
      calls++;
      return report();
    },
  });
  backend.scan(options);
  await backend.waitUntilIdle();
  const before = backend.getState();
  await assert.rejects(
    backend.configureWorkspace({ root: "/other" }, async () => {
      throw new Error("disk full");
    }),
    /disk full/,
  );
  assert.deepEqual(backend.getState(), before);
  assert.equal(calls, 1);
  assert.doesNotThrow(() => backend.assertInteractive());
});

test("closing while workspace preferences persist waits without starting a new subprocess", async () => {
  const saved = deferred();
  let calls = 0;
  const backend = new Backend({
    run: async () => {
      calls++;
      return report();
    },
  });
  const configuring = backend.configureWorkspace(options, () => saved.promise);
  assert.deepEqual(backend.requestClose(), { action: "wait" });
  saved.resolve();
  await configuring;
  await backend.waitUntilIdle();
  assert.equal(calls, 0);
  await backend.reopen();
  await backend.waitUntilIdle();
  assert.equal(calls, 1);
  assert.equal(backend.getState().root, "/work");
});

test("setup owns persistence and close cannot launch a subprocess after saving", async () => {
  const saved = deferred();
  let calls = 0;
  const backend = new Backend({
    setupRequired: true,
    run: async () => {
      calls++;
      return report();
    },
  });
  assert.equal(backend.start().setupRequired, true);
  const setup = backend.completeSetup(options, async (value) => {
    assert.equal(value.root, "/work");
    value.root = "/mutated-copy";
    await saved.promise;
  });
  assert.throws(() => backend.scan(options), /Setup is being saved/);
  assert.throws(
    () => backend.completeSetup(options, async () => {}),
    /Setup is being saved/,
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
  const backend = new Backend({
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
  const backend = new Backend({
    run: (_args, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return scan.promise;
    },
  });
  backend.scan(options);
  const reset = backend.resetPreferences(
    () => confirmation.promise,
    async () => {
      persisted = true;
    },
  );
  assert.throws(() => backend.scan(options), /already running/);
  confirmation.resolve(false);
  assert.equal((await reset).cancelled, true);
  assert.equal(aborted, false);
  assert.equal(persisted, false);
  assert.equal(backend.getState().busy, true);
  scan.resolve(report());
  await backend.waitUntilIdle();
  assert.equal(backend.getState().report.worktrees.length, 1);
});

test("confirmed reset stops a scan, persists before clearing, and reopens setup without rescanning", async () => {
  const saving = deferred(),
    saveStarted = deferred();
  let calls = 0,
    aborted = false;
  const backend = new Backend({
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
  backend.scan(options);
  const reset = backend.resetPreferences(
    async () => true,
    async () => {
      assert.equal(aborted, true);
      saveStarted.resolve();
      await saving.promise;
    },
  );
  await saveStarted.promise;
  assert.throws(() => backend.scan(options), /already running/);
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

test("reopen waits for scan cancellation and a newer close cancels pending reopen intent", async () => {
  const scan = deferred();
  let calls = 0,
    aborted = false;
  const backend = new Backend({
    run: (_args, { signal }) => {
      calls++;
      if (calls > 1) return Promise.resolve(report());
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return scan.promise;
    },
  });
  backend.scan(options);
  assert.deepEqual(backend.requestClose(), { action: "wait" });
  assert.equal(aborted, true);
  const reopening = backend.reopen();
  backend.requestClose();
  scan.resolve(report());
  await reopening;
  assert.throws(() => backend.assertInteractive(), /closing/);
  assert.equal(calls, 1);
  await backend.reopen();
  await backend.waitUntilIdle();
  assert.equal(calls, 2);
  assert.doesNotThrow(() => backend.assertInteractive());
  backend.requestClose();
  await backend.reopen();
  assert.equal(calls, 2, "healthy reopen restores cache without a rescan");
});

test("cleanup close requires consent, finishes only the current item, and restores its updated cache", async () => {
  const current = deferred();
  const second = { ...row, id: "two", path: "/work/two" };
  const calls = [];
  const backend = new Backend({
    run: (args) => {
      calls.push(args);
      return args[0] === "list"
        ? Promise.resolve(report([row, second]))
        : current.promise;
    },
  });
  backend.scan(options);
  await backend.waitUntilIdle();
  const cleanup = backend.remove({
    revision: backend.getState().revision,
    recommendedOnly: true,
    items: [row, second].map(({ id, head }) => ({ id, head })),
  });
  assert.deepEqual(backend.requestClose(), { action: "confirm-cleanup" });
  assert.doesNotThrow(() => backend.assertInteractive());
  assert.throws(
    () =>
      backend.resetPreferences(
        async () => true,
        async () => {},
      ),
    /cleanup to finish/,
  );
  assert.deepEqual(backend.requestClose({ finishCleanup: true }), {
    action: "wait",
  });
  assert.throws(() => backend.scan(options), /closing/);
  current.resolve(JSON.stringify({ path: row.path, removed: true }));
  const removed = await cleanup;
  await backend.waitUntilIdle();
  assert.equal(removed.results.length, 1);
  assert.equal(calls.length, 2);
  await backend.reopen();
  assert.equal(calls.length, 2);
  assert.deepEqual(
    backend.getState().report.worktrees.map((item) => item.id),
    ["two"],
  );
});

test("closing during native removal consent cannot start the selected deletion", async () => {
  const answer = deferred();
  let calls = 0;
  const backend = new Backend({
    run: async () => {
      calls++;
      return report();
    },
  });
  backend.scan(options);
  await backend.waitUntilIdle();
  const cleanup = backend.remove(
    {
      revision: backend.getState().revision,
      forceConfirm: true,
      items: [{ id: row.id, head: row.head }],
    },
    () => answer.promise,
  );
  backend.requestClose({ finishCleanup: true });
  answer.resolve(true);
  const result = await cleanup;
  assert.equal(result.results.length, 0);
  assert.equal(calls, 1);
});

test("close also cancels and awaits auxiliary statistics reads", async () => {
  let aborted = false;
  const backend = new Backend({
    run: (args, { signal }) => {
      assert.equal(args[0], "stats");
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          setImmediate(() => reject(new Error("stats stopped")));
        }),
      );
    },
  });
  const reading = backend.readStats();
  const failure = assert.rejects(reading, /stats stopped/);
  assert.deepEqual(backend.requestClose(), { action: "wait" });
  assert.equal(aborted, true);
  await backend.waitUntilIdle();
  await failure;
  assert.deepEqual(backend.requestClose(), { action: "close" });
});

test("closing during reset confirmation cancels native consent instead of stranding shutdown", async () => {
  const backend = new Backend({ run: async () => report() });
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
