"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { worktreeStateKind, worktreeState, projectTree } = require("../renderer/worktree-presentation.mjs");
const tree = require("./worktree-tree.mjs");

test("state kinds and row labels use one precedence, including quiet rows", () => {
  const cases = [
    [{ pending: true, dirty: true }, "Checking", null],
    [{ canRemove: false, canDiscard: false, losses: ["nested"] }, "Cannot be deleted", "Cannot be deleted"],
    [{ canRemove: false, canDiscard: false, blockers: ["Unreadable: denied"] }, "Cannot be deleted", "Unreadable"],
    [{ losses: ["nested", "submodules", "operation", "refs"], missing: true }, "Nested repository", "Nested repository"],
    [{ losses: ["submodules", "operation", "refs"], missing: true }, "Submodules", "Submodules"],
    [{ losses: ["operation", "refs"], dirty: true }, "Unfinished Git operation", "Unfinished Git operation"],
    [{ losses: ["refs"], ignored: true }, "Refs of its own", "Refs of its own"],
    [{ missing: true, dirty: true }, "Folder missing", "Folder missing"],
    [{ empty: true, dirty: true }, "Empty folder", "Empty folder"],
    [{ dirty: true, changedFiles: 1, ignored: true }, "Changed files", "1 changed file"],
    [{ dirty: true, changedFiles: 3 }, "Changed files", "3 changed files"],
    [{ dirty: true }, "Changed files", "Uncommitted changes"],
    [{ ignored: true, locked: true }, "Ignored files", "Ignored files"],
    [{ locked: true, fresh: true }, "Locked", "Locked"],
    [{ canRemove: false, losses: ["unchecked"], blockers: ["Unchecked files: assume-unchanged"], fresh: true }, "Unchecked files", "Unchecked files"],
    [{ canRemove: false, blockers: ["Protected branch (develop)"] }, "Protected branch", "Protected branch"],
    [{ fresh: true, recommended: true }, "New", "New"],
    [{ recommended: true }, "Merged", "Merged"],
    [{ detached: true, canRemove: false, blockers: ["Detached HEAD"] }, "Detached", null],
    [{}, "Not merged", null],
  ];
  for (const [facts, kind, label] of cases) {
    const row = { canRemove: true, canDiscard: true, ...facts };
    assert.equal(worktreeStateKind(row), kind, JSON.stringify(facts));
    assert.equal(worktreeState(row)?.label ?? null, label, kind);
    if (label && !["Changed files", "Cannot be deleted"].includes(kind))
      assert.equal(worktreeStateKind(row), worktreeState(row).label);
  }
});

test("state and age intersect search, recommendation and repository filters without mutating rows", () => {
  const now = Date.parse("2026-10-06T12:00:00Z"), day = 86400000;
  const row = (id, days, extra = {}) => ({
    id, path: `/work/${id}`, repo: "alpha", canRemove: true, recommended: true,
    activityAt: new Date(now - days * day).toISOString(), ...extra,
  });
  const list = [row("old", 400), row("quarter", 90), row("month", 30), row("week", 7), row("recent", 6),
    row("dirty", 400, { dirty: true, recommended: false }),
    row("other", 400, { repo: "beta" }),
    ...[undefined, null, "", "invalid", "0001-01-01T00:00:00Z", 0].map((activityAt, i) => row(`unknown-${i}`, 0, { activityAt })),
    row("main", 400, { main: true }), row("bare", 400, { bare: true })];
  const before = structuredClone(list);
  const options = { kind: worktreeStateKind, state: w => worktreeState(w)?.label };
  for (const [days, expected] of [[7, 6], [30, 5], [90, 4], [365, 3]]) {
    // Exact cutoff is included; one millisecond younger is excluded.
    const cutoff = now - days * day;
    assert.equal(tree.filter(list, { ...options, activityBefore: cutoff }).length, expected);
    assert.equal(tree.filter([row("boundary", days)], { activityBefore: cutoff }).length, 1);
    assert.equal(tree.filter([row("boundary", days)], { activityBefore: cutoff - 1 }).length, 0);
  }
  assert.deepEqual(tree.filter(list, { ...options, stateFilter: "Changed files" }).map(w => w.id), ["dirty"]);
  assert.deepEqual(tree.filter(list, { ...options, stateFilter: "Merged", activityBefore: now - 365 * day, repo: "alpha", view: "recommended", query: "old" }).map(w => w.id), ["old"]);
  assert.equal(tree.filter(list, { ...options, stateFilter: "New" }).length, 0);
  const projected = projectTree(list, { root: "/work", hosts: [], hostFilter: "", repo: "alpha", view: "recommended", search: "old", stateFilter: "Merged", ageDays: "365", now, sort: "path", collapsedDirectories: new Set() }, tree);
  assert.deepEqual(projected.filtered.map(w => w.id), ["old"]);
  assert.deepEqual(projected.visible.map(w => w.id), ["old"]);
  assert.deepEqual(list, before);
});
