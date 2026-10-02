"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  Backend,
  execute,
  parseReport,
  scanOptions,
  validatePreferences,
  childEnvironment,
} = require("./backend.cjs");

const tree = {
  id: "tree-1",
  path: "/work/topic",
  head: "a".repeat(40),
  branch: "topic",
  repo: "repo",
  canRemove: true,
  recommended: true,
  outsideRoot: false,
};
const report = (trees = [tree], root = "/work") =>
  JSON.stringify({ root, worktrees: trees, warnings: [] });
const selection = (backend, changes = {}) => ({
  items: [{ id: tree.id, head: tree.head }],
  recommendedOnly: true,
  revision: backend.getState().revision,
  ...changes,
});

test("scan returns busy state immediately, invokes CLI with exact arguments, and clones state", async () => {
  let finish;
  const calls = [];
  const backend = new Backend({
    run: (args) => {
      calls.push(args);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const state = backend.scan({
    root: "~/project's files",
    host: "user@remote",
    github: true,
    fetch: true,
  });
  assert.equal(state.busy, true);
  assert.deepEqual(calls[0], [
    "list",
    "--json",
    "--path",
    "~/project's files",
    "--host",
    "user@remote",
    "--github",
    "--fetch",
  ]);
  assert.throws(() => backend.scan({}), /already running/);
  finish(report());
  await backend.pending;
  const snapshot = backend.getState();
  assert.equal(snapshot.busy, false);
  assert.ok(snapshot.revision);
  snapshot.report.worktrees[0].head = "changed";
  assert.equal(backend.getState().report.worktrees[0].head, tree.head);
});

test("failed host change clears previous report and invalidates deletion revision", async () => {
  let fail = false;
  const backend = new Backend({
    run: async () => {
      if (fail) throw new Error("SSH unavailable");
      return report();
    },
  });
  backend.scan({ root: "/work" });
  await backend.pending;
  const old = selection(backend);
  fail = true;
  const state = backend.scan({ host: "other-host", root: "~" });
  assert.equal(state.report, null);
  assert.equal(state.revision, null);
  await backend.pending;
  assert.equal(backend.getState().report, null);
  assert.match(backend.getState().error, /SSH unavailable/);
  await assert.rejects(backend.remove(old), /scan changed/);
});

test("recommended removal binds identity, host and GitHub evidence, then refreshes without refetch", async () => {
  const calls = [];
  const source = { ...tree, pr: { merged: true } };
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "remove")
        return JSON.stringify({ path: tree.path, removed: true });
      return report(calls.length > 1 ? [] : [source]);
    },
  });
  backend.scan({ root: "~", host: "vps", github: true, fetch: true });
  await backend.pending;
  const before = backend.getState().revision;
  const result = await backend.remove(selection(backend), () => {
    throw new Error("Recommended removal should not prompt");
  });
  assert.deepEqual(calls[1], [
    "remove",
    "--yes",
    "--json",
    "--head",
    tree.head,
    "--id",
    tree.id,
    "--branch",
    tree.branch,
    "--host",
    "vps",
    "--github",
    "--recommended-only",
    "--",
    tree.path,
  ]);
  assert.equal(calls[2].includes("--fetch"), false);
  assert.equal(result.results[0].removed, true);
  assert.notEqual(result.revision, before);
  assert.equal(backend.getState().busy, false);
});

test("manual removal requires confirmation and prevents concurrent scans while dialog is open", async () => {
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return report([{ ...tree, recommended: false }]);
    },
  });
  backend.scan({});
  await backend.pending;
  let answer;
  const pending = backend.remove(
    selection(backend, { recommendedOnly: false }),
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  assert.equal(backend.operation, "remove");
  assert.equal(backend.dispose(), false);
  assert.throws(() => backend.scan({ host: "another" }), /already running/);
  answer(false);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 1);
  assert.equal(backend.state.busy, false);
});

test("stale commits, duplicate selections, protected trees, and nonrecommendations are refused", async () => {
  const backend = new Backend({ run: async () => report() });
  backend.scan({});
  await backend.pending;
  await assert.rejects(
    backend.remove(
      selection(backend, { items: [{ id: tree.id, head: "wrong" }] }),
    ),
    /changed or is protected/,
  );
  await assert.rejects(
    backend.remove(
      selection(backend, {
        items: [
          { id: tree.id, head: tree.head },
          { id: tree.id, head: tree.head },
        ],
      }),
    ),
    /Invalid worktree selection/,
  );
  backend.state.report.worktrees[0].recommended = false;
  await assert.rejects(backend.remove(selection(backend)), /not a cleanup/);
  backend.state.report.worktrees[0].canRemove = false;
  await assert.rejects(
    backend.remove(selection(backend, { recommendedOnly: false })),
    /protected/,
  );
});

test("partial cleanup errors preserve outcomes and a failed refresh does not enable stale actions", async () => {
  let calls = 0;
  const backend = new Backend({
    run: async (args) => {
      calls++;
      if (args[0] === "remove") throw new Error("Ignored files now exist");
      if (calls > 1) throw new Error("Scan failed");
      return report();
    },
  });
  backend.scan({});
  await backend.pending;
  const result = await backend.remove(selection(backend));
  assert.equal(result.results[0].removed, false);
  assert.match(result.results[0].error, /Ignored/);
  assert.equal(result.revision, null);
  assert.match(result.error, /refreshing failed/);
  assert.equal(backend.state.busy, false);
});

test("subprocess boundary preserves argument data and reports exits and malformed JSON", async () => {
  const value = "folder's $literal; text\nnext";
  const output = await execute(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "--",
    value,
  ]);
  assert.deepEqual(JSON.parse(output), [value]);
  await assert.rejects(
    execute(process.execPath, [
      "-e",
      "process.stderr.write('meaningful failure'); process.exit(2)",
    ]),
    /meaningful failure/,
  );
  assert.throws(() => parseReport("not JSON"), /invalid JSON/);
  assert.throws(() => parseReport("{}"), /incomplete scan/);
  assert.throws(() => parseReport(report([tree, tree])), /invalid worktree/);
});

test("subprocess deadlines terminate a stalled operation", async () => {
  await assert.rejects(
    execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeout: 30,
    }),
    /timed out/,
  );
});

test("input validation and preference schema are bounded and match renderer contract", () => {
  assert.throws(() => scanOptions({ host: "-bad option" }), /host alias/);
  assert.throws(() => scanOptions({ root: "a\0b" }), /Invalid scan/);
  assert.deepEqual(
    validatePreferences({
      theme: "dark",
      hosts: [{ name: "Build VPS", host: "build", root: "~/src" }],
      roots: ["/work"],
    }),
    {
      theme: "dark",
      hosts: [{ name: "Build VPS", host: "build", root: "~/src" }],
      roots: ["/work"],
    },
  );
  assert.throws(
    () => validatePreferences({ hosts: [{ host: "" }] }),
    /cannot be empty/,
  );
  assert.throws(() => validatePreferences({ theme: "other" }), /Invalid theme/);
  assert.match(childEnvironment("darwin").PATH, /\/opt\/homebrew\/bin/);
});
