"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { executeCleanupBatch } = require("./cleanup-batch.cjs");

const rows = ["one", "two"].map((id) => ({
  id,
  path: `/work/${id}`,
  branch: id,
  head: "a".repeat(40),
  canRemove: true,
}));
const plan = {
  selected: rows,
  confirmation: rows,
  discardLocal: false,
  recommendedOnly: false,
};
const callbacks = (overrides) => ({
  host: "",
  run: async (args) => JSON.stringify({ path: args.at(-1), removed: true }),
  confirm: async () => true,
  shouldStop: () => false,
  onBegin() {},
  onProgress() {},
  reconcile: async () => {},
  ...overrides,
});

test("declined cleanup consent never begins or invokes the CLI", async () => {
  const result = await executeCleanupBatch(
    plan,
    callbacks({
      confirm: async () => false,
      onBegin: () => assert.fail("must not begin"),
      run: () => assert.fail("must not execute"),
    }),
  );
  assert.deepEqual(result, { cancelled: true, results: [] });
});

test("cleanup uses one session and reconciles each result before executing the next", async () => {
  const calls = [],
    order = [];
  const result = await executeCleanupBatch(
    plan,
    callbacks({
      run: async (args) => {
        calls.push(args);
        order.push(`run:${args.at(-1)}`);
        return JSON.stringify({ path: args.at(-1), removed: true });
      },
      reconcile: async (row) => {
        order.push(`reconcile:${row.path}`);
      },
    }),
  );
  assert.deepEqual(order, [
    "run:/work/one",
    "reconcile:/work/one",
    "run:/work/two",
    "reconcile:/work/two",
  ]);
  assert.equal(
    calls[0][calls[0].indexOf("--stats-session") + 1],
    calls[1][calls[1].indexOf("--stats-session") + 1],
  );
  assert.equal(result.results.length, 2);
});

test("finish-current stops before another action without interrupting the current one", async () => {
  let stop = false,
    calls = 0;
  const result = await executeCleanupBatch(
    plan,
    callbacks({
      run: async (args) => {
        calls++;
        stop = true;
        return JSON.stringify({ path: args.at(-1), removed: true });
      },
      shouldStop: () => stop,
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.results, [{ path: rows[0].path, removed: true }]);
});

test("a successful response for another path is a failed action, never a confirmed removal", async () => {
  const outcomes = [];
  const result = await executeCleanupBatch(
    { ...plan, selected: [rows[0]] },
    callbacks({
      run: async () => JSON.stringify({ path: "/unselected", removed: true }),
      reconcile: async (_row, outcome) => {
        outcomes.push(outcome);
      },
    }),
  );
  assert.deepEqual(result.results, [
    {
      path: rows[0].path,
      removed: false,
      error: "Arbor did not confirm removal",
    },
  ]);
  assert.deepEqual(outcomes, result.results);
});
