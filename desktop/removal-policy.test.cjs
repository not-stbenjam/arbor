"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Backend } = require("./backend.cjs");
const { execute, CommandError } = require("./process-runner.cjs");
const {
  planRemoval,
  removalArguments,
  removalFailure,
} = require("./removal-policy.cjs");

const first = {
  id: "first",
  path: "/work/topic",
  head: "a".repeat(40),
  branch: "topic",
  commonDir: "/repo-a/.git",
  canRemove: true,
  recommended: true,
  sizeBytes: 42,
};
const second = { ...first, id: "second", commonDir: "/repo-b/.git" };
const report = (rows = [first, second]) =>
  JSON.stringify({ root: "/work", worktrees: rows, warnings: [] });
const selection = (backend, rows = [first, second]) => ({
  revision: backend.getState().revision,
  recommendedOnly: true,
  items: rows.map(({ id, head }) => ({ id, head })),
});

test("removal plan validates every identity but consents to each physical path once", () => {
  const state = { revision: "snapshot", report: JSON.parse(report()) };
  const request = {
    revision: "snapshot",
    items: [first, second],
    forceConfirm: true,
  };
  const plan = planRemoval(state, request);
  assert.deepEqual(plan.selected, [first]);
  assert.deepEqual(plan.confirmation, [first]);
  plan.selected[0].path = "/changed";
  assert.equal(state.report.worktrees[0].path, first.path);
  assert.throws(
    () => planRemoval(state, { ...request, items: [first, first] }),
    /Invalid worktree selection/,
  );
  assert.throws(
    () =>
      planRemoval(state, {
        ...request,
        items: [first, { ...second, head: "stale" }],
      }),
    /changed/,
  );
});

test("removal argv binds repository, identity, consent and stats session without shell interpolation", () => {
  const row = {
    ...first,
    path: "/work/$(literal folder)",
    missing: true,
    empty: true,
    canRemove: false,
    pr: { merged: true },
  };
  assert.deepEqual(
    removalArguments(row, {
      host: "vps",
      statsSession: "batch",
      discardLocal: true,
      recommendedOnly: false,
    }),
    [
      "remove",
      "--yes",
      "--json",
      "--stats-session",
      "batch",
      "--head",
      first.head,
      "--id",
      first.id,
      "--branch",
      "topic",
      "--repo",
      first.commonDir,
      "--expect-missing",
      "--expect-empty",
      "--host",
      "vps",
      "--github",
      "--discard-local",
      "--",
      row.path,
    ],
  );
});

test("structured failures require one exact failed target and never infer success", () => {
  const failure = {
    path: first.path,
    removed: false,
    error: "Remove the legacy lock after checking its owner",
  };
  for (const value of [failure, [failure]]) {
    assert.equal(
      removalFailure(
        { stdout: JSON.stringify(value), message: "generic" },
        first.path,
      ),
      failure.error,
    );
  }
  for (const value of [
    { ...failure, path: "/other" },
    { ...failure, removed: true },
    [failure, failure],
    { ...failure, error: "x".repeat(8193) },
    { ...failure, error: "bad\0error" },
  ]) {
    assert.equal(
      removalFailure(
        { stdout: JSON.stringify(value), message: "generic" },
        first.path,
      ),
      "generic",
    );
  }
  assert.equal(
    removalFailure({ stdout: "broken JSON", message: "generic" }, first.path),
    "generic",
  );
  assert.equal(removalFailure(null, first.path), "Worktree removal failed");
  assert.equal(
    new CommandError("generic", { code: 1, stdout: "x".repeat(65537) }).stdout,
    "",
  );
});

test("nonzero CLI stdout preserves actionable legacy-lock failure through backend cleanup", async () => {
  const detail =
    "Legacy lock has no owner metadata. Inspect /repo-a/.git/arbor.lock, then remove the stale lock manually.";
  const failure = JSON.stringify([
    { path: first.path, removed: false, error: detail },
  ]);
  const backend = new Backend({
    run: (args) =>
      args[0] === "list"
        ? Promise.resolve(report([first]))
        : execute(process.execPath, [
            "-e",
            `process.stdout.write(${JSON.stringify(failure)});process.stderr.write('some worktrees could not be removed');process.exitCode=1;`,
          ]),
  });
  backend.scan({ root: "/work" });
  await backend.waitUntilIdle();
  const result = await backend.remove(selection(backend, [first]));
  assert.equal(result.results[0].removed, false);
  assert.equal(result.results[0].error, detail);
  assert.equal(result.report.worktrees[0].lastRemovalError, detail);
});

test("same-path batch removes once then refreshes the remaining registration by ID", async () => {
  const calls = [];
  const missing = {
    ...second,
    missing: true,
    sizeBytes: 0,
    canRemove: false,
    canDiscard: true,
    recommended: false,
  };
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "remove")
        return JSON.stringify({ path: first.path, removed: true });
      return args.includes("--target-only") ? report([missing]) : report();
    },
  });
  backend.scan({ root: "/work" });
  await backend.waitUntilIdle();
  const result = await backend.remove(selection(backend));
  assert.equal(result.results.length, 1);
  assert.equal(calls.filter((args) => args[0] === "remove").length, 1);
  assert.equal(
    calls.filter(
      (args) => args[0] === "list" && !args.includes("--target-only"),
    ).length,
    1,
  );
  assert.equal(calls[2][calls[2].indexOf("--repo") + 1], second.commonDir);
  assert.deepEqual(result.report.worktrees, [
    { ...missing, retryInspection: false },
  ]);
});

test("failed cleanup and targeted inspection affect only the selected registration ID", async () => {
  for (const mismatch of [false, true]) {
    const fresh = {
      ...second,
      dirty: true,
      canRemove: false,
      canDiscard: true,
      recommended: false,
    };
    const backend = new Backend({
      run: async (args) => {
        if (args[0] === "remove") throw new Error("files changed");
        return args.includes("--target-only")
          ? report(mismatch ? [first] : [first, fresh])
          : report();
      },
    });
    backend.scan({ root: "/work" });
    await backend.waitUntilIdle();
    const result = await backend.remove(selection(backend, [second]));
    assert.deepEqual(result.report.worktrees[0], first);
    const updated = result.report.worktrees[1];
    assert.equal(updated.id, second.id);
    assert.equal(updated.lastRemovalError, "files changed");
    if (mismatch) {
      assert.equal(updated.retryInspection, true);
      assert.match(updated.inspectionError, /different identity/);
      assert.equal(updated.canDiscard, false);
    } else {
      assert.equal(updated.dirty, true);
      assert.equal(updated.retryInspection, false);
    }
  }
});

test("closing cleanup retains sibling registration as needing inspection, never deleted", async () => {
  let finish;
  const calls = [];
  const backend = new Backend({
    run: (args) => {
      calls.push(args);
      return args[0] === "list"
        ? Promise.resolve(report())
        : new Promise((resolve) => {
            finish = resolve;
          });
    },
  });
  backend.scan({ root: "/work" });
  await backend.waitUntilIdle();
  const removing = backend.remove(selection(backend));
  backend.requestClose({ finishCleanup: true });
  finish(JSON.stringify({ path: first.path, removed: true }));
  const result = await removing;
  assert.equal(calls.length, 2);
  assert.equal(result.report.worktrees.length, 1);
  assert.equal(result.report.worktrees[0].id, second.id);
  assert.equal(result.report.worktrees[0].retryInspection, true);
});
