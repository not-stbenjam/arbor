"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateStats } = require("./aggregate-stats.cjs");

test("all-host statistics sum totals and days without changing host reports", () => {
  const local = {
    removedWorktrees: 2,
    estimatedBytesReclaimed: 10,
    cleanupSessions: 1,
    largestWorktreeBytes: 8,
    firstCleanupAt: "2026-01-02T00:00:00Z",
    lastCleanupAt: "2026-01-03T00:00:00Z",
    daily: [
      { date: "2026-01-03", removedWorktrees: 2, estimatedBytesReclaimed: 10 },
    ],
  };
  const remote = {
    removedWorktrees: 3,
    estimatedBytesReclaimed: 20,
    cleanupSessions: 2,
    largestWorktreeBytes: 12,
    firstCleanupAt: "2026-01-01T00:00:00Z",
    lastCleanupAt: "2026-01-04T00:00:00Z",
    daily: [
      { date: "2026-01-03", removedWorktrees: 1, estimatedBytesReclaimed: 5 },
      { date: "2026-01-04", removedWorktrees: 2, estimatedBytesReclaimed: 15 },
    ],
  };
  const before = structuredClone([local, remote]);
  const combined = aggregateStats([
    { host: "", report: local },
    { host: "vps", report: remote },
  ]);
  assert.equal(combined.removedWorktrees, 5);
  assert.equal(combined.estimatedBytesReclaimed, 30);
  assert.equal(combined.cleanupSessions, 3);
  assert.equal(combined.largestWorktreeBytes, 12);
  assert.equal(combined.daily[0].removedWorktrees, 3);
  assert.equal(combined.daily[0].estimatedBytesReclaimed, 15);
  assert.equal(combined.firstCleanupAt, remote.firstCleanupAt);
  assert.equal(combined.lastCleanupAt, remote.lastCleanupAt);
  assert.deepEqual([local, remote], before);
});

test("unavailable hosts produce partial totals, not a false zero history", () => {
  const failures = [
    { host: "offline", error: new Error("connection unavailable") },
  ];
  assert.throws(() => aggregateStats(failures), /could not be loaded/);
  const report = aggregateStats([
    { host: "", report: { removedWorktrees: 4, daily: [] } },
    ...failures,
  ]);
  assert.equal(report.removedWorktrees, 4);
  assert.match(
    report.warning,
    /Partial totals.*offline.*connection unavailable/,
  );
  assert.equal(aggregateStats([]).removedWorktrees, 0);
  // A host is called what its owner named it, as in the rest of the window.
  assert.equal(
    aggregateStats([
      { host: "", report: { removedWorktrees: 1, daily: [] } },
      { host: "10.0.0.7", label: "Build server", error: "unreachable" },
    ]).warning,
    "Partial totals. Build server: unreachable",
  );
});
