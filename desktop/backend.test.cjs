"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  Backend,
  execute,
  parseReport,
  scanOptions,
  validatePreferences,
  loadPreferences,
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
    "--progress",
    "--path",
    "~/project's files",
    "--host",
    "user@remote",
    "--github",
    "--fetch",
    "--no-default-excludes",
    ...scanOptions().excludes.flatMap((entry) => ["--exclude", entry]),
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
      setupCompleted: false,
      exclusionDefaultsVersion: 1,
      scan: {
        root: "/work",
        host: "",
        github: false,
        fetch: false,
        excludes: scanOptions().excludes,
      },
    },
  );
  assert.throws(
    () => validatePreferences({ hosts: [{ host: "" }] }),
    /cannot be empty/,
  );
  assert.throws(() => validatePreferences({ theme: "other" }), /Invalid theme/);
  assert.match(childEnvironment("darwin").PATH, /\/opt\/homebrew\/bin/);
});

test("first launch cannot scan until setup is completed", () => {
  let calls = 0;
  const backend = new Backend({
    setupRequired: true,
    run: () => {
      calls++;
    },
  });
  assert.equal(backend.getState().setupRequired, true);
  assert.equal(backend.getState().progress, null);
  assert.throws(() => backend.scan({}), /Complete setup/);
  assert.equal(calls, 0);
});

test("scan exposes actual progress with a stable start time and resets it on completion", async () => {
  let finish, progress;
  const backend = new Backend({
    run: (_args, callbacks) => {
      progress = callbacks.onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const initial = backend.scan({ root: "/work", github: true });
  assert.equal(initial.progress.stage, "starting");
  assert.equal(initial.options.github, true);
  progress({
    stage: "inspecting",
    path: "/work/topic",
    discovered: 4,
    completed: 1,
    total: 4,
  });
  const active = backend.getState();
  assert.equal(active.progress.startedAt, initial.progress.startedAt);
  assert.equal(active.progress.completed, 1);
  assert.equal(active.busy, true);
  progress({
    stage: "invalid",
    path: "",
    discovered: -1,
    completed: 0,
    total: 0,
  });
  assert.equal(backend.getState().progress.stage, "inspecting");
  finish(report());
  await backend.pending;
  assert.equal(backend.getState().progress, null);
});

test("progress protocol handles split UTF-8, split lines, multiple events and final unterminated lines", async () => {
  const first = {
    stage: "discovering",
    path: "/work/🌳",
    discovered: 1,
    completed: 0,
    total: 0,
  };
  const second = { ...first, stage: "inspecting", completed: 1, total: 1 };
  const events = [];
  const script = `
    const bytes = Buffer.from(${JSON.stringify("@arbor-progress " + JSON.stringify(first) + "\n@arbor-progress " + JSON.stringify(second))});
    let i=0;
    const write = () => {
      if(i===bytes.length) { process.stdout.write('ok'); return; }
      process.stderr.write(bytes.subarray(i,++i)); setTimeout(write,1);
    }; write();`;
  assert.equal(
    await execute(process.execPath, ["-e", script], {
      onProgress: (event) => events.push(event),
    }),
    "ok",
  );
  assert.deepEqual(events, [first, second]);
});

test("progress lines do not hide real stderr errors or malformed protocol data", async () => {
  const event = {
    stage: "discovering",
    path: "",
    discovered: 0,
    completed: 0,
    total: 0,
  };
  const errors = "@arbor-progress not json\nmeaningful failure";
  await assert.rejects(
    execute(
      process.execPath,
      [
        "-e",
        `process.stderr.write(${JSON.stringify("@arbor-progress " + JSON.stringify(event) + "\n" + errors)}); process.exitCode=2;`,
      ],
      { onProgress: () => {} },
    ),
    (error) => {
      assert.equal(error.message, errors);
      return true;
    },
  );
});

test("large stderr lines are preserved and cannot bypass the progress protocol bound", async () => {
  const large = "x".repeat(70000);
  await assert.rejects(
    execute(
      process.execPath,
      [
        "-e",
        `process.stderr.write(${JSON.stringify(large)}); process.exitCode=2;`,
      ],
      { onProgress: () => assert.fail("not a progress event") },
    ),
    (error) => {
      assert.equal(error.message, large);
      return true;
    },
  );
});

test("preferences migrate to setup and preserve saved scan choices", () => {
  assert.equal(validatePreferences({}).setupCompleted, false);
  const scan = { root: "~/src", host: "vps", github: true, fetch: true };
  const prefs = validatePreferences({ setupCompleted: true, scan });
  assert.equal(prefs.setupCompleted, true);
  assert.deepEqual(prefs.scan, { ...scan, excludes: scanOptions().excludes });
  assert.throws(
    () => validatePreferences({ scan: { host: "bad host" } }),
    /host alias/,
  );
});

test("scan exclusions use defaults only when omitted and preserve an explicit empty list", async () => {
  assert.ok(scanOptions().excludes.includes("node_modules"));
  assert.ok(scanOptions().excludes.includes("~/.codex/.tmp"));
  assert.deepEqual(scanOptions({ excludes: [] }).excludes, []);
  for (const excludes of [[""], ["\0"], "tmp", Array(101).fill("tmp")])
    assert.throws(() => scanOptions({ excludes }));
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return report();
    },
  });
  backend.scan({ excludes: ["build stuff", "~/Library/Caches"] });
  await backend.pending;
  assert.deepEqual(calls[0].slice(-5), [
    "--no-default-excludes",
    "--exclude",
    "build stuff",
    "--exclude",
    "~/Library/Caches",
  ]);
  backend.scan({ excludes: [] });
  await backend.pending;
  assert.equal(calls[1].at(-1), "--no-default-excludes");
  assert.equal(calls[1].includes("--exclude"), false);
});

test("saved default exclusions upgrade without overriding custom or explicitly removed rules", () => {
  const current = scanOptions().excludes;
  const previous = current.filter((rule) => rule !== "~/.codex/.tmp");
  const original = {
    setupCompleted: true,
    scan: { root: "/projects", excludes: previous },
  };
  const migrated = loadPreferences(original);
  assert.deepEqual(migrated.scan.excludes, current);
  assert.equal(migrated.scan.root, "/projects");
  assert.equal(migrated.setupCompleted, true);
  assert.deepEqual(original.scan.excludes, previous);
  assert.deepEqual(
    loadPreferences({ scan: { excludes: [...previous].reverse() } }).scan
      .excludes,
    current,
  );
  for (const excludes of [
    [],
    ["custom-cache"],
    [...previous, "custom-cache"],
  ]) {
    assert.deepEqual(
      loadPreferences({ scan: { excludes } }).scan.excludes,
      excludes,
    );
  }
  const optedOut = validatePreferences({
    ...migrated,
    scan: { ...migrated.scan, excludes: previous },
  });
  assert.deepEqual(loadPreferences(optedOut).scan.excludes, previous);
});

test("live worktrees upsert by path, remain non-removable, and are cleared after failure", async () => {
  let progress, rejectScan;
  const backend = new Backend({
    run: (_args, callbacks) => {
      progress = callbacks.onProgress;
      return new Promise((_resolve, reject) => {
        rejectScan = reject;
      });
    },
  });
  backend.scan({ root: "/work" });
  const event = {
    stage: "discovery",
    path: tree.path,
    discovered: 1,
    completed: 0,
    total: 0,
  };
  progress({
    ...event,
    worktree: { ...tree, id: "provisional", branch: "" },
    pending: true,
  });
  assert.equal(backend.getState().partialWorktrees.length, 1);
  assert.equal(backend.getState().partialWorktrees[0].pending, true);
  progress({
    ...event,
    stage: "inspect",
    completed: 1,
    total: 1,
    worktree: tree,
    pending: false,
  });
  const state = backend.getState();
  assert.equal(state.partialWorktrees.length, 1);
  assert.equal(state.partialWorktrees[0].id, tree.id);
  assert.equal(state.partialWorktrees[0].pending, false);
  assert.equal(state.partialWorktrees[0].canRemove, false);
  assert.equal(state.partialWorktrees[0].recommended, false);
  assert.equal(state.report, null);
  assert.equal(state.revision, null);
  state.partialWorktrees[0].branch = "edited";
  assert.equal(backend.getState().partialWorktrees[0].branch, tree.branch);
  rejectScan(new Error("failed scan"));
  await backend.pending;
  assert.deepEqual(backend.getState().partialWorktrees, []);
});

test("stopping a scan waits for completion, preserves incomplete rows, and discards a racing final report", async () => {
  let finish, callbacks;
  const backend = new Backend({
    run: (_args, opts) => {
      callbacks = opts;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  backend.scan({});
  callbacks.onProgress({
    stage: "inspect",
    path: tree.path,
    discovered: 1,
    completed: 1,
    total: 1,
    worktree: tree,
    pending: false,
  });
  assert.equal(backend.getState().canCancelScan, true);
  const stopping = backend.cancelScan();
  assert.equal(stopping.busy, true);
  assert.equal(stopping.cancelRequested, true);
  assert.equal(callbacks.signal.aborted, true);
  finish(report());
  await backend.pending;
  const stopped = backend.getState();
  assert.equal(stopped.busy, false);
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.cancelRequested, false);
  assert.equal(stopped.report, null);
  assert.equal(stopped.revision, null);
  assert.equal(stopped.partialWorktrees.length, 1);
  assert.equal(stopped.partialWorktrees[0].canRemove, false);
  assert.throws(() => backend.cancelScan(), /No cancellable scan/);
  backend.scan({});
  assert.equal(backend.getState().cancelled, false);
  assert.deepEqual(backend.getState().partialWorktrees, []);
  finish(report());
  await backend.pending;
});

test("explicit cancellation suppresses only the stopped scan's failure", async () => {
  const backend = new Backend({
    run: (_args, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("signal terminated")),
          { once: true },
        );
      }),
  });
  backend.scan({});
  backend.cancelScan();
  await backend.pending;
  assert.equal(backend.getState().error, "");
  assert.equal(backend.getState().cancelled, true);
});

test("cleanup is not a cancellable scan", async () => {
  const backend = new Backend({
    run: async () => report([{ ...tree, recommended: false }]),
  });
  backend.scan({});
  await backend.pending;
  let decide;
  const remove = backend.remove(
    selection(backend, { recommendedOnly: false }),
    () =>
      new Promise((resolve) => {
        decide = resolve;
      }),
  );
  assert.equal(backend.getState().canCancelScan, false);
  assert.throws(() => backend.cancelScan(), /No cancellable scan/);
  decide(false);
  await remove;
});

test("abort signal actually terminates a running child process", async () => {
  const controller = new AbortController();
  const pending = execute(
    process.execPath,
    ["-e", "setInterval(() => {},1000)"],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, /scan stopped/);
});

test("reset returns to first launch defaults without scanning or deleting worktrees", async () => {
  const calls = [];
  const backend = new Backend({
    version: "v1.2.3",
    platform: "darwin",
    githubAvailable: true,
    run: async (args) => {
      calls.push(args);
      return report();
    },
  });
  backend.scan({
    root: "~/other",
    host: "vps",
    github: true,
    fetch: true,
    excludes: [],
  });
  await backend.pending;
  backend.state.error = "Old diagnostic";
  const reset = backend.reset();
  assert.equal(reset.setupRequired, true);
  assert.equal(reset.busy, false);
  assert.equal(reset.report, null);
  assert.equal(reset.revision, null);
  assert.equal(reset.progress, null);
  assert.equal(reset.error, "");
  assert.equal(reset.root, "");
  assert.equal(reset.host, "");
  assert.equal(reset.cancelled, false);
  assert.equal(reset.canCancelScan, false);
  assert.equal(reset.version, "v1.2.3");
  assert.equal(reset.platform, "darwin");
  assert.equal(reset.githubAvailable, true);
  assert.deepEqual(reset.partialWorktrees, []);
  assert.deepEqual(reset.options, scanOptions());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "list");
  assert.throws(() => backend.scan({}), /Complete setup/);
  assert.equal(calls.length, 1);
  reset.options.excludes.push("should not change state");
  assert.deepEqual(backend.getState().options, scanOptions());
});

test("reset refuses an active scan and clears stopped partial state only after completion", async () => {
  let finish, callbacks;
  const backend = new Backend({
    run: (_args, options) => {
      callbacks = options;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  backend.scan({});
  callbacks.onProgress({
    stage: "inspect",
    path: tree.path,
    discovered: 1,
    completed: 1,
    total: 1,
    worktree: tree,
    pending: false,
  });
  assert.throws(() => backend.reset(), /current operation/);
  backend.cancelScan();
  assert.throws(() => backend.reset(), /current operation/);
  finish(report());
  await backend.pending;
  assert.equal(backend.getState().partialWorktrees.length, 1);
  const reset = backend.reset();
  assert.equal(reset.cancelled, false);
  assert.deepEqual(reset.partialWorktrees, []);
  assert.equal(reset.progress, null);
  assert.equal(reset.setupRequired, true);
});

test("reset refuses cleanup and closing state", async () => {
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return report([{ ...tree, recommended: false }]);
    },
  });
  backend.scan({});
  await backend.pending;
  let confirm;
  const pending = backend.remove(
    selection(backend, { recommendedOnly: false }),
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  assert.throws(() => backend.reset(), /current operation/);
  confirm(false);
  await pending;
  assert.equal(calls.length, 1);
  backend.dispose();
  assert.throws(() => backend.reset(), /closing/);
});

test("glob exclusions persist and cross the subprocess boundary as literal argument data", async () => {
  const excludes = [
    "~/.codex*/.tmp",
    "node_modules",
    "~/agent[12]/scratch?",
    "**/build",
  ];
  const preferences = validatePreferences({
    setupCompleted: true,
    scan: { root: "/work", excludes },
  });
  assert.deepEqual(preferences.scan.excludes, excludes);
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return report();
    },
  });
  backend.scan(preferences.scan);
  await backend.pending;
  assert.deepEqual(
    calls[0].slice(-excludes.length * 2),
    excludes.flatMap((rule) => ["--exclude", rule]),
  );
  const echoed = await execute(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "--",
    ...excludes,
  ]);
  assert.deepEqual(JSON.parse(echoed), excludes);
});
