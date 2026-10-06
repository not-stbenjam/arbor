"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Backend } = require("./backend.cjs");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const { scanOptions } = require("./protocol.cjs");
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

test("a refusal is reported in the window's terms, not with command-line flags", () => {
  const refusal =
    "not removed: Uncommitted or untracked files. Add --force to remove it anyway; run without --yes first to see what that involves";
  const said =
    "Not deleted. It has changed since the list was read: Uncommitted or untracked files. Nothing in it was touched; its row now shows what it holds.";
  assert.equal(
    removalFailure(
      { stdout: JSON.stringify({ path: "/work/topic", removed: false, error: refusal }) },
      "/work/topic",
    ),
    said,
  );
  assert.equal(removalFailure({ message: refusal }, "/work/topic"), said);
  // Anything else is passed on as it was said.
  assert.equal(
    removalFailure({ message: "worktree commit or branch changed; scan again" }, "/work/topic"),
    "worktree commit or branch changed; scan again",
  );
});

test("a selection reviewed in the window is asked about again only when something would be discarded", () => {
  const clean = { ...first, recommended: false };
  const dirty = {
    ...first,
    id: "dirty",
    path: "/work/dirty",
    recommended: false,
    canRemove: false,
    canDiscard: true,
    losses: ["changes"],
  };
  const state = {
    revision: "snapshot",
    report: { worktrees: [first, { ...clean, id: "clean", path: "/work/clean" }, dirty] },
  };
  const items = [first, { ...clean, id: "clean" }];
  // Unreviewed, a clean worktree that is not a recommendation is asked about.
  assert.deepEqual(
    planRemoval(state, { revision: "snapshot", items }).confirmation.map((row) => row.id),
    ["clean"],
  );
  // Reviewed, nothing more is asked: none of them has anything to lose.
  assert.deepEqual(
    planRemoval(state, { revision: "snapshot", items, reviewed: true }).confirmation,
    [],
  );
  // Discarding is asked about whatever the window says it showed.
  assert.deepEqual(
    planRemoval(state, {
      revision: "snapshot",
      items: [...items, dirty],
      reviewed: true,
      discardLocal: true,
    }).confirmation.map((row) => row.id),
    ["first", "clean", "dirty"],
  );
  // And a reviewed selection cannot take a worktree that is not clean
  // without that consent.
  assert.throws(
    () =>
      planRemoval(state, { revision: "snapshot", items: [dirty], reviewed: true }),
    /changed or is protected/,
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
      "--progress",
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
  await backend.configureWorkspace({ root: "/work" }, async () => {});
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
  await backend.configureWorkspace({ root: "/work" }, async () => {});
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
    await backend.configureWorkspace({ root: "/work" }, async () => {});
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
  await backend.configureWorkspace({ root: "/work" }, async () => {});
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

test("targeted retry drops an externally unregistered ID and updates other cached workspaces", async () => {
  const cache = new WorkspaceCache();
  const alternate = scanOptions({ root: "/", github: true });
  cache.put(alternate, JSON.parse(report()));
  const calls = [];
  let inspectAttempts = 0;
  const backend = new Backend({
    cache,
    run: async (args) => {
      calls.push(args);
      if (args.includes("--target-only")) {
        inspectAttempts++;
        if (inspectAttempts === 1)
          throw new Error("temporary inspection failure");
        return report([]);
      }
      return report();
    },
  });
  await backend.configureWorkspace({ root: "/work" }, async () => {});
  await backend.waitUntilIdle();
  backend.inspectWorktree({
    id: first.id,
    revision: backend.getState().revision,
  });
  await backend.waitUntilIdle();
  assert.equal(backend.getState().report.worktrees[0].retryInspection, true);
  backend.inspectWorktree({
    id: first.id,
    revision: backend.getState().revision,
  });
  await backend.waitUntilIdle();
  const state = backend.getState();
  assert.equal(state.error, "");
  assert.deepEqual(state.report.worktrees, [second]);
  assert.deepEqual(cache.get(alternate).worktrees, [second]);
  await backend.configureWorkspace(
    scanOptions({ root: "/work" }),
    async () => {},
    { restore: true },
  );
  assert.equal(backend.getState().cached, true);
  assert.deepEqual(backend.getState().report.worktrees, [second]);
  assert.equal(
    calls.length,
    3,
    "only initial scan and two targeted inspections run",
  );
});

test("cleanup invalidates only its exact ID in other cached snapshots", async () => {
  const cache = new WorkspaceCache();
  const alternate = scanOptions({ root: "/", github: true });
  cache.put(alternate, JSON.parse(report()));
  const backend = new Backend({
    cache,
    run: async (args) =>
      args[0] === "remove"
        ? JSON.stringify({ path: first.path, removed: true })
        : report([first]),
  });
  await backend.configureWorkspace({ root: "/work" }, async () => {});
  await backend.waitUntilIdle();
  await backend.remove(selection(backend, [first]));
  assert.deepEqual(cache.get(alternate).worktrees, [second]);
});

test("outside-root selections are refused even when permissive flags are present", () => {
  const state = {
    revision: "snapshot",
    report: JSON.parse(report([{ ...first, outsideRoot: true }])),
  };
  assert.throws(
    () => planRemoval(state, { revision: "snapshot", items: [first] }),
    /protected/,
  );
});

test("wrong-path removal success does not remove the selected row or cached registration", async () => {
  const cache = new WorkspaceCache();
  const options = scanOptions({ root: "/work" });
  const backend = new Backend({
    cache,
    run: async (args) =>
      args[0] === "remove"
        ? JSON.stringify({ path: "/other", removed: true })
        : report([first]),
  });
  await backend.configureWorkspace(options, async () => {});
  await backend.waitUntilIdle();
  const result = await backend.remove(selection(backend, [first]));
  assert.equal(result.results[0].removed, false);
  assert.equal(result.results[0].error, "Arbor did not confirm removal");
  assert.equal(result.report.worktrees[0].id, first.id);
  assert.equal(cache.get(options).worktrees[0].id, first.id);
});

test("targeted inspection refuses matching ID returned at another physical path", async () => {
  const backend = new Backend({
    run: async (args) =>
      report([
        args.includes("--target-only") ? { ...first, path: "/other" } : first,
      ]),
  });
  await backend.configureWorkspace({ root: "/work" }, async () => {});
  await backend.waitUntilIdle();
  backend.inspectWorktree({
    id: first.id,
    revision: backend.getState().revision,
  });
  await backend.waitUntilIdle();
  const current = backend.getState().report.worktrees[0];
  assert.equal(current.path, first.path);
  assert.equal(current.retryInspection, true);
  assert.match(current.inspectionError, /different identity/);
});

test("losses graver than files are passed on by name, and only with consent to discard", () => {
  const { removalArguments } = require("./removal-policy.cjs");
  const row = {
    id: "id",
    path: "/work/topic",
    head: "a".repeat(40),
    branch: "topic",
    canRemove: false,
    canDiscard: true,
    losses: ["changes", "submodules", "nested", "something-newer"],
  };
  const args = (discardLocal) =>
    removalArguments(row, {
      host: "",
      statsSession: "batch",
      discardLocal,
      recommendedOnly: false,
    });
  const discard = args(true);
  // Files in the folder are covered by --discard-local itself. What is named
  // is what the confirmation named, and nothing this app does not know.
  assert.deepEqual(
    discard.slice(discard.indexOf("--discard-local"), discard.indexOf("--")),
    ["--discard-local", "--acknowledge", "submodules", "--acknowledge", "nested"],
  );
  assert.equal(args(false).includes("--acknowledge"), false);
  assert.ok(args(false).includes("--keep-local"));
});
