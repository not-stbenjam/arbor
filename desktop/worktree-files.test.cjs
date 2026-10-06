"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFiles } = require("./protocol.cjs");
const { LOSSES } = require("./common/losses.mjs");
const fixture = () => ({
  path: "/work/topic", head: "a".repeat(40), branch: "topic", truncated: false, sizeLowerBound: false,
  counts: Object.fromEntries(Object.keys(LOSSES).map((kind) => [kind, kind === "changes" ? 1 : 0])),
  bytes: Object.fromEntries(Object.keys(LOSSES).map((kind) => [kind, kind === "changes" ? 12 : 0])),
  warnings: [], entries: [{ kind: "changes", path: "a\nfile", status: "modified", directory: false, sizeBytes: 12, sizeLowerBound: false }],
});
test("file inventory validates kinds, counts, sizes, and text before crossing the bridge", () => {
  assert.deepEqual(parseFiles(JSON.stringify(fixture())), fixture());
  for (const mutate of [
    (r) => r.entries[0].kind = "unknown", (r) => r.entries[0].status = "unknown",
    (r) => r.entries[0].path = "bad\0file", (r) => r.path = "x".repeat(4097),
    (r) => r.entries[0].sizeBytes = -1, (r) => r.bytes.changes = Number.MAX_SAFE_INTEGER + 1,
    (r) => r.entries[0].files = 0.1, (r) => r.counts.changes = 0,
    (r) => r.bytes.changes = 0, (r) => r.counts.unknown = 1,
    (r) => r.entries.push(r.entries[0]), (r) => r.entries[0].sizeLowerBound = true,
    (r) => r.warnings = ["bad\0warning"], (r) => r.truncated = "false",
    (r) => r.entries[0].directory = true,
    (r) => r.truncated = true,
    (r) => r.bytes.changes = 13,
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => parseFiles(JSON.stringify(value)), /invalid file inventory/);
  }
  const limited = fixture(); limited.truncated = true; limited.counts.changes = 3; limited.bytes.changes = 40;
  assert.equal(parseFiles(JSON.stringify(limited)).counts.changes, 3);
});

test("backend resolves row IDs, routes the host, rejects stale revisions and mismatched output", async () => {
  const { Backend } = require("./backend.cjs");
  const { WorkspaceCache } = require("./workspace-cache.cjs");
  const { scanOptions } = require("./protocol.cjs");
  for (const host of ["", "fixture-host"]) {
    const options = scanOptions({ root: "/work", host });
    const cache = new WorkspaceCache();
    cache.put(options, { root: "/work", warnings: [], worktrees: [{ id: "row", path: "/work/topic", commonDir: "/work/repo/.git", head: "a".repeat(40), branch: "topic" }] });
    const calls = []; let output = fixture();
    const backend = new Backend({ cache, run: async (args) => { calls.push(args); return JSON.stringify(output); } });
    await backend.configureWorkspace(options, async () => {}, { restore: true });
    const selection = { id: "row", revision: backend.getState().revision, path: "/untrusted" };
    await backend.worktreeFiles(selection);
    assert.deepEqual(calls[0], ["files", "--json", "--repo", "/work/repo/.git", ...(host ? ["--host", host] : []), "--", "/work/topic"]);
    await assert.rejects(backend.worktreeFiles({ ...selection, revision: "old" }), /changed/);
    await assert.rejects(backend.worktreeFiles({ ...selection, id: "absent" }), /no longer/);
    output = { ...fixture(), path: "/wrong" };
    await assert.rejects(backend.worktreeFiles(selection), /different worktree/);
  }
});


test("files resolve newly discovered registrations alongside the saved rows", async () => {
  const { Backend } = require("./backend.cjs");
  const { WorkspaceCache } = require("./workspace-cache.cjs");
  const { scanOptions } = require("./protocol.cjs");
  const options = scanOptions({ root: "/work" });
  const cache = new WorkspaceCache();
  const checked = { id: "checked", path: "/work/old", commonDir: "/work/repo/.git", head: "a".repeat(40), branch: "old" };
  const discovered = { ...checked, id: "discovered", path: "/work/topic", branch: "topic" };
  cache.put(options, { root: "/work", worktrees: [checked], warnings: [] });
  let progress, finish;
  const backend = new Backend({ cache, run: (args, callbacks) => {
    if (args[0] === "files") return Promise.resolve(JSON.stringify(fixture()));
    progress = callbacks.onProgress;
    return new Promise((resolve) => { finish = resolve; });
  } });
  await backend.configureWorkspace(options, async () => {}, { restore: true });
  await backend.configureWorkspace(options, async () => {});
  progress({ stage: "discovery", path: discovered.path, discovered: 1, completed: 0, total: 0, worktree: discovered, pending: true });
  try {
    const state = backend.getState();
    assert.equal(state.report.worktrees.length, 1);
    assert.equal(state.partialWorktrees.length, 1);
    const report = await backend.worktreeFiles({ id: discovered.id, revision: state.revision });
    assert.equal(report.path, discovered.path);
  } finally {
    finish(JSON.stringify({ root: "/work", worktrees: [checked, discovered], warnings: [] }));
    await backend.waitUntilIdle();
  }
});
