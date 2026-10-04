"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { WorkspaceCache, cacheKey } = require("./workspace-cache.cjs");
const { Backend } = require("./backend.cjs");
const { scanOptions } = require("./protocol.cjs");

const row = {
  id: "one",
  path: "/work/topic",
  head: "a".repeat(40),
  branch: "topic",
  canRemove: true,
  recommended: true,
};
const report = (worktrees = [row], root = "/work") => ({
  root,
  worktrees,
  warnings: [],
  scannedAt: "2026-01-01T00:00:00Z",
});
const options = (extra = {}) => scanOptions({ root: "/work", ...extra });

test("cache separates hosts and all scan options, clones reports, and normalizes exclusion order", () => {
  const cache = new WorkspaceCache();
  cache.put(options(), report());
  assert.ok(cache.get(options()));
  for (const changed of [
    { host: "remote" },
    { root: "/other" },
    { github: true },
    { fetch: true },
    { excludes: [] },
  ])
    assert.equal(cache.get(options(changed)), null);
  const snapshot = cache.get(options());
  snapshot.worktrees.length = 0;
  assert.equal(cache.get(options()).worktrees.length, 1);
  assert.equal(
    cacheKey(options({ excludes: ["a", "b"] })),
    cacheKey(options({ excludes: ["b", "a"] })),
  );
});

test("canonical roots reuse and replace the same cached workspace without stale aliases", () => {
  const cache = new WorkspaceCache();
  const original = options({ host: "remote", root: "~" });
  cache.put(original, report([row], "/home/person"));
  assert.ok(cache.get(options({ host: "remote", root: "/home/person" })));
  cache.put(
    options({ host: "remote", root: "/home/person" }),
    report([], "/home/person"),
  );
  // The old alias must not retain the stale deleted row.
  assert.equal(cache.get(original).worktrees.length, 0);
  assert.equal(
    cache.get(options({ host: "remote", root: "/home/person" })).worktrees
      .length,
    0,
  );
});

test("bounded LRU keeps recently visited workspaces and bounds serialized bytes", () => {
  const cache = new WorkspaceCache({ maxEntries: 2 });
  for (const host of ["one", "two"]) cache.put(options({ host }), report());
  cache.get(options({ host: "one" }));
  cache.put(options({ host: "three" }), report());
  assert.ok(cache.get(options({ host: "one" })));
  assert.equal(cache.get(options({ host: "two" })), null);
  const small = new WorkspaceCache({ maxBytes: 100 });
  small.put(options(), report());
  assert.equal(small.entries.size, 0);
  assert.ok(Buffer.byteLength(small.serialize()) <= 100);
});

test("confirmed deletions prune exact registrations across same-host snapshots, retaining nested registrations", () => {
  const cache = new WorkspaceCache();
  const rows = [
    row,
    { ...row, id: "nested", path: "/work/topic/nested" },
    { ...row, id: "sibling", path: "/work/topic-other" },
  ];
  for (const setup of [
    options(),
    options({ root: "/", github: true }),
    options({ host: "remote" }),
  ])
    cache.put(setup, report(rows, setup.root));
  cache.removePaths("", [row.path]);
  assert.deepEqual(
    cache.get(options()).worktrees.map((w) => w.id),
    ["nested", "sibling"],
  );
  assert.deepEqual(
    cache.get(options({ root: "/", github: true })).worktrees.map((w) => w.id),
    ["nested", "sibling"],
  );
  assert.equal(cache.get(options({ host: "remote" })).worktrees.length, 3);
});

test("failed inspection evicts its workspace and aliases without replacing healthy snapshots", () => {
  const cache = new WorkspaceCache();
  const remoteHome = options({ host: "remote", root: "~" });
  const remotePath = options({ host: "remote", root: "/home/person" });
  cache.put(remoteHome, report([row], "/home/person"));
  cache.put(options(), report());
  const failed = {
    ...row,
    canRemove: false,
    recommended: false,
    canDiscard: false,
    retryInspection: true,
    inspectionError: "timed out",
    lastRemovalError: "changed",
  };
  cache.put(remotePath, report([failed], "/home/person"));
  assert.equal(cache.get(remoteHome), null);
  assert.equal(cache.get(remotePath), null);
  assert.equal(cache.get(options()).worktrees[0].canRemove, true);
  const inspected = {
    ...row,
    retryInspection: false,
    lastRemovalError: "changed",
    inspectionError: "old failure",
  };
  cache.put(remotePath, report([inspected], "/home/person"));
  assert.deepEqual(cache.get(remotePath).worktrees, [row]);
  assert.equal(
    inspected.lastRemovalError,
    "changed",
    "live error remains available until the user dismisses it",
  );
});

test("legacy disk snapshots cannot restore failed inspection state or transient errors", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "arbor-cache-failure-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "workspace-cache.json");
  await fs.writeFile(
    filename,
    JSON.stringify({
      version: 1,
      entries: [
        {
          options: options(),
          report: report([{ ...row, retryInspection: true, canRemove: false }]),
        },
        {
          options: options({ host: "remote" }),
          report: report([
            { ...row, lastRemovalError: "old error", retryInspection: false },
          ]),
        },
      ],
    }),
  );
  const cache = await WorkspaceCache.open(filename);
  assert.equal(cache.get(options()), null);
  assert.deepEqual(cache.get(options({ host: "remote" })).worktrees, [row]);
  await cache.pending;
});

test("disk snapshots survive restart, write atomically, and tolerate corruption/reset", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "arbor-cache-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "workspace-cache.json");
  const cache = await WorkspaceCache.open(filename);
  cache.put(options(), report());
  cache.put(options({ host: "remote" }), report());
  await cache.pending;
  assert.deepEqual(await fs.readdir(directory), ["workspace-cache.json"]);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  const restored = await WorkspaceCache.open(filename);
  assert.equal(restored.get(options()).scannedAt, report().scannedAt);
  restored.clear();
  await restored.pending;
  assert.equal((await WorkspaceCache.open(filename)).get(options()), null);
  await fs.writeFile(filename, "{corrupt");
  assert.equal((await WorkspaceCache.open(filename)).get(options()), null);
});

test("workspace activation restores immediately with fresh revision; explicit refresh invokes CLI", async () => {
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return JSON.stringify(report());
    },
  });
  await backend.activateWorkspace(options());
  await backend.waitUntilIdle();
  const first = backend.getState().revision;
  await backend.activateWorkspace(options({ host: "remote" }));
  await backend.waitUntilIdle();
  const restored = await backend.activateWorkspace(options());
  assert.equal(restored.busy, false);
  assert.equal(restored.cached, true);
  assert.equal(restored.report.scannedAt, report().scannedAt);
  assert.notEqual(restored.revision, first);
  assert.equal(calls.length, 2);
  await assert.rejects(
    backend.remove({
      revision: first,
      items: [{ id: row.id, head: row.head }],
    }),
    /scan changed/,
  );
  backend.scan(options());
  await backend.waitUntilIdle();
  assert.equal(calls.length, 3);
  assert.equal(backend.getState().cached, false);
});

test("switching cancels a read-only scan and waits for settlement before restoring", async () => {
  const cache = new WorkspaceCache();
  cache.put(options(), report());
  let aborted = false;
  const backend = new Backend({
    cache,
    run: (_args, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          setTimeout(() => reject(new Error("stopped")), 5);
        });
      }),
  });
  backend.scan(options({ host: "slow" }));
  const restored = await backend.activateWorkspace(options());
  assert.equal(aborted, true);
  assert.equal(restored.busy, false);
  assert.equal(restored.host, "");
  assert.equal(restored.cached, true);
  assert.equal(cache.get(options({ host: "slow" })), null);
});

test("cleanup updates all cached snapshots, uses one stats session, and refuses workspace switching while deleting", async () => {
  const cache = new WorkspaceCache();
  const second = { ...row, id: "two", path: "/work/other" };
  cache.put(options(), report([row, second]));
  cache.put(options({ root: "/", github: true }), report([row, second], "/"));
  const calls = [];
  const backend = new Backend({
    cache,
    run: async (args) => {
      calls.push(args);
      return JSON.stringify({ path: args.at(-1), removed: true });
    },
  });
  await backend.activateWorkspace(options());
  let approve;
  const cleanup = backend.remove(
    {
      revision: backend.getState().revision,
      items: [row, second].map(({ id, head }) => ({ id, head })),
      forceConfirm: true,
    },
    () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  );
  await assert.rejects(
    backend.activateWorkspace(options({ host: "remote" })),
    /already running/,
  );
  approve(true);
  await cleanup;
  assert.equal(calls.length, 2);
  const sessions = calls.map(
    (args) => args[args.indexOf("--stats-session") + 1],
  );
  assert.ok(sessions[0]);
  assert.equal(sessions[0], sessions[1]);
  assert.equal(cache.get(options()).worktrees.length, 0);
  assert.equal(
    cache.get(options({ root: "/", github: true })).worktrees.length,
    0,
  );
  await backend.resetPreferences(
    async () => true,
    async () => {},
  );
  assert.equal(cache.entries.size, 0);
  assert.equal(backend.getState().setupRequired, true);
});
