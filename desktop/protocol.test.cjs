"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseReport,
  isValidReport,
  progressEvent,
  scanOptions,
  DEFAULTS,
  validatePreferences,
  loadPreferences,
} = require("./protocol.cjs");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const defaults = require("../internal/config/defaults.json");

test("per-host preference scans migrate legacy state and validate bounded unique host identities", () => {
  const legacy = scanOptions({
    host: "remote",
    root: "/remote",
    excludes: [],
    github: true,
  });
  assert.deepEqual(loadPreferences({ scan: legacy }).scans, [legacy]);
  const local = scanOptions({ root: "/local", excludes: ["local"] });
  const value = validatePreferences({ scan: legacy, scans: [local, legacy] });
  assert.deepEqual(value.scans, [local, legacy]);
  assert.throws(
    () => validatePreferences({ scans: [local, local] }),
    /Duplicate per-host/,
  );
  assert.throws(() => validatePreferences({ scans: {} }), /per-host scan/);
  assert.throws(
    () =>
      validatePreferences({
        scans: Array.from({ length: 102 }, (_, i) => ({ host: `host-${i}` })),
      }),
    /per-host scan/,
  );
  assert.throws(
    () => validatePreferences({ scans: [{ host: "bad host" }] }),
    /host alias/,
  );
  const previousDefaults = DEFAULTS.excludes.filter(
    (rule) => rule !== "~/.codex/.tmp",
  );
  const migrated = loadPreferences({
    scan: { excludes: previousDefaults },
    scans: [{ excludes: previousDefaults }, legacy],
  });
  assert.deepEqual(migrated.scans[0].excludes, DEFAULTS.excludes);
  assert.deepEqual(migrated.scans[1].excludes, []);
});
const row = {
  id: "linked",
  path: "/repo/linked",
  head: "a".repeat(40),
  branch: "topic",
  canRemove: true,
  canDiscard: true,
  recommended: true,
  publishedRefs: null,
  blockers: null,
  problems: null,
  discardWarnings: null,
};
const report = (rows = [row]) => ({
  root: "/repo",
  worktrees: rows,
  warnings: [],
});

test("CLI, progress, and cache share worktree metadata validation", () => {
  assert.deepEqual(parseReport(JSON.stringify(report())), report());
  for (const mutation of [
    { canRemove: "true" },
    { sizeBytes: -1 },
    { head: null },
    { blockers: [42] },
    { path: "/repo/\0bad" },
    { path: "" },
    { id: "" },
    { pr: { number: "1", merged: true } },
  ]) {
    const malformed = { ...row, ...mutation };
    assert.equal(isValidReport(report([malformed])), false);
    assert.throws(
      () => parseReport(JSON.stringify(report([malformed]))),
      /invalid worktree/,
    );
    const event = progressEvent({
      stage: "inspect",
      path: "/repo",
      discovered: 1,
      completed: 0,
      total: 1,
      worktree: malformed,
    });
    assert.equal(event.worktree, undefined);
    const cache = new WorkspaceCache();
    cache.put(scanOptions({ root: "/repo" }), report([malformed]));
    assert.equal(cache.get(scanOptions({ root: "/repo" })), null);
  }
});

test("complete snapshots reject duplicate IDs but permit distinct registrations at one path; partial rows cannot authorize deletion", () => {
  assert.equal(isValidReport(report([row, { ...row }])), false);
  assert.equal(
    isValidReport(report([row, { ...row, path: "/another/path" }])),
    false,
  );
  assert.equal(isValidReport(report([row, { ...row, id: "other" }])), true);
  const event = progressEvent({
    stage: "inspect",
    path: "/repo",
    discovered: 1,
    completed: 1,
    total: 1,
    pending: false,
    worktree: row,
  });
  assert.equal(event.worktree.canRemove, false);
  assert.equal(event.worktree.canDiscard, false);
  assert.equal(event.worktree.recommended, false);
});

test("desktop consumes authoritative scan defaults and exclusion limit without mutable aliases", () => {
  assert.deepEqual(DEFAULTS, defaults);
  const options = scanOptions();
  options.excludes.length = 0;
  assert.deepEqual(scanOptions().excludes, defaults.excludes);
  assert.equal(
    scanOptions({ excludes: Array(128).fill("build") }).excludes.length,
    128,
  );
  assert.throws(
    () => scanOptions({ excludes: Array(129).fill("build") }),
    /128/,
  );
});

test("long display copy is normalized without changing identity or removal flags", () => {
  const long = "x".repeat(4100);
  const source = report([
    {
      ...row,
      subject: long,
      author: long,
      lockReason: long,
      mergeReason: long,
      problems: [long],
      pr: { number: 1, merged: true, title: long },
    },
  ]);
  source.warnings = [long];
  const normalized = parseReport(JSON.stringify(source));
  assert.equal(normalized.worktrees[0].subject.length, 4096);
  assert.equal(normalized.worktrees[0].pr.title.length, 4096);
  assert.equal(normalized.worktrees[0].problems[0].length, 4096);
  assert.equal(normalized.warnings[0].length, 4096);
  assert.equal(normalized.worktrees[0].path, row.path);
  assert.equal(normalized.worktrees[0].canRemove, row.canRemove);
  const cache = new WorkspaceCache();
  const options = scanOptions({ root: "/repo" });
  cache.put(options, source);
  assert.deepEqual(cache.get(options), normalized);
  assert.equal(source.worktrees[0].subject.length, 4100);
  assert.throws(
    () => parseReport(JSON.stringify(report([{ ...row, path: long }]))),
    /invalid worktree/,
  );
});
