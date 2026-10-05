"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LiveWorktrees } = require("./live-worktrees.cjs");

const discovered = (path) => ({ id: `path:${path}`, path });
const registered = (id, path, extra = {}) => ({
  id,
  path,
  commonDir: "/repo/.git",
  ...extra,
});

test("a discovered folder becomes its registration in place, then its inspection", () => {
  const live = new LiveWorktrees(10);
  live.update(discovered("/work/a"), true);
  live.update(discovered("/work/b"), true);
  live.update(registered("b", "/work/b"), false);
  assert.deepEqual(
    live.rows.map((row) => row.id),
    ["path:/work/a", "b"],
    "identity replaces the provisional row without reordering the list",
  );
  live.update(registered("b", "/work/b", { branch: "topic" }), false);
  assert.equal(live.rows.length, 2);
  assert.equal(live.rows[1].branch, "topic");
  // The path was consumed by its registration; a second identity is new.
  live.update(registered("copy", "/work/b"), false);
  assert.deepEqual(
    live.rows.map((row) => row.id),
    ["path:/work/a", "b", "copy"],
  );
});

test("an ambiguous path never lends its row to a registration", () => {
  const live = new LiveWorktrees(10);
  live.update(discovered("/work/shared"), true);
  live.update({ id: "other:/work/shared", path: "/work/shared" }, true);
  live.update(registered("one", "/work/shared"), false);
  assert.deepEqual(
    live.rows.map((row) => row.id),
    ["path:/work/shared", "other:/work/shared", "one"],
    "two provisional rows claim the path, so neither is replaced",
  );
});

test("rows are bounded, and clearing forgets identities as well as rows", () => {
  const live = new LiveWorktrees(2);
  for (const name of ["a", "b", "c"])
    live.update(registered(name, `/work/${name}`), false);
  assert.deepEqual(
    live.rows.map((row) => row.id),
    ["a", "b"],
  );
  live.update(registered("a", "/work/a", { branch: "kept" }), false);
  assert.equal(live.rows[0].branch, "kept", "known rows still update at limit");
  const before = live.rows;
  live.clear();
  assert.deepEqual(live.rows, []);
  assert.equal(before.length, 2, "a published row list is never emptied");
  live.update(registered("a", "/work/a"), false);
  assert.deepEqual(
    live.rows.map((row) => row.id),
    ["a"],
  );
});
