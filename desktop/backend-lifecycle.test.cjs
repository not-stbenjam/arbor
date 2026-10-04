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
  assert.throws(
    () => backend.configureWorkspace(options, async () => {}),
    /already running/,
  );
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

test("failed workspace persistence warns but scans using the requested session options", async () => {
  let calls = 0;
  const backend = new Backend({
    run: async () => {
      calls++;
      return report();
    },
  });
  await backend.configureWorkspace(options, async () => {});
  await backend.waitUntilIdle();
  await backend.configureWorkspace({ root: "/other" }, async () => {
    throw new Error("disk full");
  });
  await backend.waitUntilIdle();
  assert.equal(backend.getState().options.root, "/other");
  assert.equal(backend.getState().error, "");
  assert.match(
    backend.getState().warning,
    /Could not save settings: disk full/,
  );
  assert.ok(backend.getState().report);
  assert.equal(calls, 2);
  assert.doesNotThrow(() => backend.assertInteractive());
  await backend.configureWorkspace(options, async () => {});
  assert.equal(backend.getState().warning, "");
  await backend.waitUntilIdle();
});

test("failed preference save still activates a cached host without rescanning", async () => {
  let calls = 0;
  const backend = new Backend({
    run: async () => {
      calls++;
      return report();
    },
  });
  const remote = { ...options, host: "vps" };
  await backend.configureWorkspace(remote, async () => {});
  await backend.waitUntilIdle();
  await backend.configureWorkspace(options, async () => {});
  await backend.waitUntilIdle();
  const restored = await backend.configureWorkspace(
    remote,
    async () => {
      throw new Error("read-only profile");
    },
    { restore: true },
  );
  assert.equal(calls, 2);
  assert.equal(restored.host, "vps");
  assert.equal(restored.cached, true);
  assert.equal(restored.error, "");
  assert.match(restored.warning, /read-only profile/);
  assert.equal(restored.report.worktrees.length, 1);
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
  await backend.configureWorkspace(options, async () => {});
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
  await backend.configureWorkspace(options, async () => {});
  await backend.waitUntilIdle();
  const cleanup = backend.remove({
    revision: backend.getState().revision,
    recommendedOnly: true,
    items: [row, second].map(({ id, head }) => ({ id, head })),
  });
  assert.deepEqual(backend.requestClose(), { action: "confirm-cleanup" });
  assert.doesNotThrow(() => backend.assertInteractive());
  assert.deepEqual(backend.requestClose({ finishCleanup: true }), {
    action: "wait",
  });
  assert.throws(
    () => backend.configureWorkspace(options, async () => {}),
    /closing/,
  );
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
  await backend.configureWorkspace(options, async () => {});
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
