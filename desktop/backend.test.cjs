"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const {
  removalConfirmationOptions,
} = require("./removal-confirmation.cjs");
const { DEFAULTS } = require("./protocol.cjs");
const {
  parseReport,
  scanOptions,
  validatePreferences,
  loadPreferences,
} = require("./protocol.cjs");
const { Backend } = require("./backend.cjs");
const { execute, childEnvironment } = require("./process-runner.cjs");

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

test("cached manual cleanup binds consent and missing/empty expectations without rescanning", async () => {
  for (const kind of ["locked", "detached", "missing", "empty"]) {
    const cached = {
      ...tree,
      canRemove: false,
      canDiscard: true,
      recommended: false,
      [kind]: true,
      dirty: false,
      ignored: false,
    };
    const cache = new WorkspaceCache();
    const options = scanOptions({ root: "/work" });
    cache.put(options, JSON.parse(report([cached])));
    const calls = [];
    const backend = new Backend({
      cache,
      run: async (args) => {
        calls.push(args);
        assert.equal(args[0], "remove", "cached activation must not rescan");
        return JSON.stringify({ path: tree.path, removed: true });
      },
    });
    await backend.configureWorkspace(options, async () => {}, {
      restore: true,
    });
    assert.equal(backend.getState().cached, true);
    await backend.remove(
      selection(backend, { recommendedOnly: false, discardLocal: true }),
      (rows, { discardLocal }) => {
        const dialog = removalConfirmationOptions(rows, discardLocal);
        if (kind === "locked" || kind === "detached") {
          assert.match(dialog.detail, /Any local files.*permanently discarded/);
          assert.equal(dialog.buttons[1], "Discard & Delete");
        } else assert.doesNotMatch(dialog.detail, /permanently discarded/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("--discard-local"));
    assert.equal(calls[0].includes("--expect-missing"), kind === "missing");
    assert.equal(calls[0].includes("--expect-empty"), kind === "empty");
  }
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
  const state = await backend.configureWorkspace(
    {
      root: "~/project's files",
      host: "user@remote",
      github: true,
      fetch: true,
    },
    async () => {},
  );
  assert.equal(state.busy, true);
  assert.deepEqual(calls[0], [
    "list",
    "--json",
    "--progress",
    "--linked-only",
    "--path",
    "~/project's files",
    "--host",
    "user@remote",
    "--github",
    "--fetch",
    "--no-default-excludes",
    ...scanOptions().excludes.flatMap((entry) => ["--exclude", entry]),
  ]);
  assert.throws(
    () => backend.configureWorkspace({}, async () => {}),
    /already running/,
  );
  finish(report());
  await backend.waitUntilIdle();
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
  await backend.configureWorkspace({ root: "/work" }, async () => {});
  await backend.waitUntilIdle();
  const old = selection(backend);
  fail = true;
  const state = await backend.configureWorkspace(
    { host: "other-host", root: "~" },
    async () => {},
  );
  assert.equal(state.report, null);
  assert.equal(state.revision, null);
  await backend.waitUntilIdle();
  assert.equal(backend.getState().report, null);
  assert.match(backend.getState().error, /SSH unavailable/);
  await assert.rejects(backend.remove(old), /scan changed/);
});

test("recommended removal binds identity, host and GitHub evidence, then updates without rescanning", async () => {
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
  await backend.configureWorkspace(
    { root: "~", host: "vps", github: true, fetch: true },
    async () => {},
  );
  await backend.waitUntilIdle();
  const before = backend.getState().revision;
  const result = await backend.remove(selection(backend), () => {
    throw new Error("Recommended removal should not prompt");
  });
  assert.deepEqual(calls[1], [
    "remove",
    "--yes",
    "--json",
    "--progress",
    "--stats-session",
    calls[1][5],
    "--head",
    tree.head,
    "--id",
    tree.id,
    "--branch",
    tree.branch,
    "--host",
    "vps",
    "--github",
    "--keep-local",
    "--recommended-only",
    "--",
    tree.path,
  ]);
  assert.match(calls[1][5], /^[0-9a-f-]{36}$/);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.report.worktrees, []);
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
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  let answer;
  const pending = backend.remove(
    selection(backend, { recommendedOnly: false }),
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  assert.equal(backend.getState().busy, true);
  assert.deepEqual(backend.requestClose(), { action: "confirm-cleanup" });
  assert.throws(
    () => backend.configureWorkspace({ host: "another" }, async () => {}),
    /already running/,
  );
  answer(false);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 1);
  assert.equal(backend.getState().busy, false);
});

test("stale commits, duplicate selections, protected trees, and nonrecommendations are refused", async () => {
  const source = { ...tree };
  const backend = new Backend({ run: async () => report([source]) });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
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
  source.recommended = false;
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  await assert.rejects(backend.remove(selection(backend)), /not a cleanup/);
  source.canRemove = false;
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  await assert.rejects(
    backend.remove(selection(backend, { recommendedOnly: false })),
    /protected/,
  );
});

test("failed target reinspection keeps a retry action without a full rescan", async () => {
  let calls = 0;
  const backend = new Backend({
    run: async (args) => {
      calls++;
      if (args[0] === "remove") throw new Error("Ignored files now exist");
      if (calls > 1) throw new Error("Scan failed");
      return report();
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  const result = await backend.remove(selection(backend));
  assert.equal(result.results[0].removed, false);
  assert.match(result.results[0].error, /Ignored/);
  assert.ok(result.revision);
  assert.equal(result.error, "");
  assert.equal(result.report.worktrees[0].canRemove, false);
  assert.equal(result.report.worktrees[0].recommended, false);
  assert.match(
    result.report.worktrees[0].lastRemovalError,
    /Ignored files now exist/,
  );
  assert.match(result.report.worktrees[0].blockers[0], /Scan failed/);
  assert.equal(result.report.worktrees[0].retryInspection, true);
  assert.equal(calls, 3);
  assert.equal(backend.getState().busy, false);
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
      sort: "path",
      descending: false,
      hostFilter: null,
      exclusionDefaultsVersion: 2,
      scans: [scanOptions({ root: "/work" })],
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
  const initial = await backend.configureWorkspace(
    { root: "/work", github: true },
    async () => {},
  );
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
  await backend.waitUntilIdle();
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

test("large stderr lines are bounded diagnostics and cannot bypass the progress protocol bound", async () => {
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
      assert.ok(Buffer.byteLength(error.message) <= 4096);
      assert.match(error.message, /^x+\n… \[diagnostic truncated\]$/);
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
  for (const excludes of [
    [""],
    ["\0"],
    "tmp",
    Array(DEFAULTS.maxExcludes + 1).fill("tmp"),
  ])
    assert.throws(() => scanOptions({ excludes }));
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return report();
    },
  });
  await backend.configureWorkspace(
    { excludes: ["build stuff", "~/Library/Caches"] },
    async () => {},
  );
  await backend.waitUntilIdle();
  assert.deepEqual(calls[0].slice(-5), [
    "--no-default-excludes",
    "--exclude",
    "build stuff",
    "--exclude",
    "~/Library/Caches",
  ]);
  await backend.configureWorkspace({ excludes: [] }, async () => {});
  await backend.waitUntilIdle();
  assert.equal(calls[1].at(-1), "--no-default-excludes");
  assert.equal(calls[1].includes("--exclude"), false);
});

test("saved default exclusions upgrade without overriding custom or explicitly removed rules", () => {
  const current = scanOptions().excludes;
  // The complete default lists earlier releases shipped, oldest first.
  const second = current.filter(
    (rule) =>
      !["~/.local/share/containers", "~/.local/share/docker"].includes(rule),
  );
  const first = second.filter((rule) => rule !== "~/.codex/.tmp");
  const original = {
    setupCompleted: true,
    scan: { root: "/projects", excludes: first },
  };
  const migrated = loadPreferences(original);
  assert.deepEqual(migrated.scan.excludes, current);
  assert.equal(migrated.scan.root, "/projects");
  assert.equal(migrated.setupCompleted, true);
  assert.equal(migrated.exclusionDefaultsVersion, 2);
  assert.deepEqual(original.scan.excludes, first);
  assert.deepEqual(
    loadPreferences({ scan: { excludes: [...first].reverse() } }).scan.excludes,
    current,
  );
  assert.deepEqual(
    loadPreferences({
      exclusionDefaultsVersion: 1,
      scan: { excludes: second },
    }).scan.excludes,
    current,
  );
  for (const exclusionDefaultsVersion of [undefined, 1, 2])
    for (const excludes of [[], ["custom-cache"], [...first, "custom-cache"]])
      assert.deepEqual(
        loadPreferences({ exclusionDefaultsVersion, scan: { excludes } }).scan
          .excludes,
        excludes,
      );
  // A list trimmed back after an upgrade is a choice, not an older default.
  assert.deepEqual(
    loadPreferences({ exclusionDefaultsVersion: 1, scan: { excludes: first } })
      .scan.excludes,
    first,
  );
  for (const excludes of [first, second]) {
    const optedOut = validatePreferences({
      ...migrated,
      scan: { ...migrated.scan, excludes },
    });
    assert.deepEqual(loadPreferences(optedOut).scan.excludes, excludes);
  }
});

test("live worktrees replace provisional paths, retain registration IDs, and clear after failure", async () => {
  let progress, rejectScan;
  const backend = new Backend({
    run: (_args, callbacks) => {
      progress = callbacks.onProgress;
      return new Promise((_resolve, reject) => {
        rejectScan = reject;
      });
    },
  });
  await backend.configureWorkspace({ root: "/work" }, async () => {});
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
  const copied = {
    ...tree,
    id: "copy",
    commonDir: "/copied/.git",
    branch: "copy-topic",
  };
  progress({ ...event, worktree: copied, pending: true });
  progress({
    ...event,
    stage: "inspect",
    worktree: { ...tree, branch: "updated" },
    pending: false,
  });
  progress({ ...event, stage: "inspect", worktree: copied, pending: false });
  assert.deepEqual(
    backend.getState().partialWorktrees.map((row) => [row.id, row.branch]),
    [
      [tree.id, "updated"],
      ["copy", "copy-topic"],
    ],
  );
  rejectScan(new Error("failed scan"));
  await backend.waitUntilIdle();
  assert.deepEqual(backend.getState().partialWorktrees, []);
});

test("registration discovery and inspection retain distinct same-path IDs", async () => {
  let progress, finish;
  const backend = new Backend({
    run: (_args, callbacks) => {
      progress = callbacks.onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await backend.configureWorkspace({ root: "/work" }, async () => {});
  const rows = [
    { ...tree, commonDir: "/original/.git" },
    { ...tree, id: "copied-registration", commonDir: "/copied/.git" },
  ];
  const emit = (worktree, stage = "discovery") =>
    progress({
      stage,
      path: tree.path,
      worktree,
      pending: stage === "discovery",
      discovered: 2,
      completed: 0,
      total: 2,
    });
  emit({ ...tree, id: "provisional", commonDir: "", head: "", branch: "" });
  for (const row of rows) emit(row);
  assert.deepEqual(
    backend.getState().partialWorktrees.map((row) => row.id),
    rows.map((row) => row.id),
  );
  for (const row of rows.toReversed())
    emit({ ...row, subject: row.id }, "inspect");
  assert.deepEqual(
    backend
      .getState()
      .partialWorktrees.map((row) => [row.id, row.subject, row.pending]),
    rows.map((row) => [row.id, row.id, false]),
  );
  finish(report(rows));
  await backend.waitUntilIdle();
  assert.equal(backend.getState().report.worktrees.length, 2);
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
  await backend.configureWorkspace({}, async () => {});
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
  await backend.waitUntilIdle();
  const stopped = backend.getState();
  assert.equal(stopped.busy, false);
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.cancelRequested, false);
  assert.equal(stopped.report, null);
  assert.equal(stopped.revision, null);
  assert.equal(stopped.partialWorktrees.length, 1);
  assert.equal(stopped.partialWorktrees[0].canRemove, false);
  assert.throws(() => backend.cancelScan(), /No cancellable scan/);
  await backend.configureWorkspace({}, async () => {});
  assert.equal(backend.getState().cancelled, false);
  assert.deepEqual(backend.getState().partialWorktrees, []);
  finish(report());
  await backend.waitUntilIdle();
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
  await backend.configureWorkspace({}, async () => {});
  backend.cancelScan();
  await backend.waitUntilIdle();
  assert.equal(backend.getState().error, "");
  assert.equal(backend.getState().cancelled, true);
});

test("cleanup is not a cancellable scan", async () => {
  const backend = new Backend({
    run: async () => report([{ ...tree, recommended: false }]),
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
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
  await backend.configureWorkspace(preferences.scan, async () => {});
  await backend.waitUntilIdle();
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

test("cleanup stops after its current worktree without rescanning or touching remaining selections", async () => {
  const second = {
    ...tree,
    id: "tree-2",
    path: "/work/topic-2",
    branch: "topic-2",
  };
  const untouched = {
    ...tree,
    id: "tree-3",
    path: "/work/topic-3",
    branch: "topic-3",
  };
  const calls = [];
  let finish;
  const backend = new Backend({
    run: (args) => {
      calls.push(args);
      if (args[0] === "list")
        return Promise.resolve(report([tree, second, untouched]));
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  const before = backend.getState().revision;
  const pending = backend.remove(
    selection(backend, {
      items: [tree, second].map(({ id, head }) => ({ id, head })),
    }),
  );
  assert.equal(backend.getState().progress.stage, "removing");
  assert.equal(backend.getState().progress.total, 2);
  assert.equal(backend.getState().progress.path, tree.path);
  assert.deepEqual(
    backend.requestClose({ finishCleanup: true }),
    { action: "wait" },
    "current removal must never be killed",
  );
  finish(JSON.stringify({ path: tree.path, removed: true }));
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.results, [{ path: tree.path, removed: true }]);
  assert.deepEqual(result.report.worktrees, [second, untouched]);
  assert.notEqual(result.revision, before);
  assert.deepEqual(backend.requestClose(), { action: "close" });
});

test("disposing an ordinary scan aborts it without waiting for the child in the close handler", async () => {
  let signal;
  const backend = new Backend({
    run: (_args, callbacks) =>
      new Promise((_resolve, reject) => {
        signal = callbacks.signal;
        signal.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        });
      }),
  });
  await backend.configureWorkspace({}, async () => {});
  assert.deepEqual(backend.requestClose(), { action: "wait" });
  assert.equal(signal.aborted, true);
  await backend.waitUntilIdle();
  assert.equal(backend.getState().busy, false);
  assert.equal(backend.getState().report, null);
});

test("explicit discard requires confirmation and flags only worktrees needing it", async () => {
  const dirty = {
    ...tree,
    id: "dirty",
    path: "/work/dirty",
    canRemove: false,
    canDiscard: true,
    recommended: false,
    discardWarnings: ["Uncommitted files will be lost"],
  };
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return args[0] === "list"
        ? report([tree, dirty])
        : JSON.stringify({ path: args.at(-1), removed: true });
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  const request = selection(backend, {
    items: [tree, dirty].map(({ id, head }) => ({ id, head })),
    recommendedOnly: false,
    discardLocal: true,
  });
  let confirmations = 0;
  const result = await backend.remove(request, async (rows, options) => {
    confirmations++;
    assert.equal(options.discardLocal, true);
    assert.deepEqual(rows, [tree, dirty]);
    return true;
  });
  assert.equal(confirmations, 1);
  assert.equal(calls[1].includes("--discard-local"), false);
  assert.equal(calls[1].includes("--keep-local"), true);
  assert.equal(calls[2].includes("--discard-local"), true);
  assert.equal(calls[2].includes("--keep-local"), false);
  assert.deepEqual(result.report.worktrees, []);
});

test("discard cannot bypass confirmation, structural blockers, or recommendation-only mode", async () => {
  const source = {
    ...tree,
    canRemove: false,
    canDiscard: true,
    recommended: false,
  };
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return report([source]);
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  await assert.rejects(
    backend.remove(selection(backend, { discardLocal: true })),
    /recommended-only/,
  );
  await assert.rejects(
    backend.remove(selection(backend, { recommendedOnly: false })),
    /protected/,
  );
  const result = await backend.remove(
    selection(backend, { recommendedOnly: false, discardLocal: true }),
  );
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 1);
  source.canDiscard = false;
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  await assert.rejects(
    backend.remove(
      selection(backend, { recommendedOnly: false, discardLocal: true }),
      async () => true,
    ),
    /protected/,
  );
});

test("folder deletion can explicitly request one confirmation even for recommended rows", async () => {
  const backend = new Backend({ run: async () => report() });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  let count = 0;
  const result = await backend.remove(
    selection(backend, { forceConfirm: true }),
    async () => {
      count++;
      return false;
    },
  );
  assert.equal(count, 1);
  assert.equal(result.cancelled, true);
});

test("manual deletion of a recommended row does not silently require recommendation revalidation", async () => {
  const calls = [];
  const retainedBranch = "arbor/recovered-topic";
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      return args[0] === "list"
        ? report()
        : JSON.stringify({ path: tree.path, removed: true, retainedBranch });
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  let confirmations = 0;
  const result = await backend.remove(
    selection(backend, { recommendedOnly: false, forceConfirm: true }),
    async () => {
      confirmations++;
      return true;
    },
  );
  assert.equal(confirmations, 1);
  assert.equal(calls[1].includes("--recommended-only"), false);
  assert.equal(calls[1].includes("--keep-local"), true);
  assert.equal(calls[1].includes("--discard-local"), false);
  assert.deepEqual(result.results, [
    { path: tree.path, removed: true, retainedBranch },
  ]);
});

test("failed deletion re-inspects only its exact path and keeps the untouched snapshot", async () => {
  const other = { ...tree, id: "other", path: "/work/other" };
  const fresh = {
    ...tree,
    head: "b".repeat(40),
    canRemove: false,
    recommended: false,
    canDiscard: true,
    dirty: true,
  };
  const calls = [];
  const backend = new Backend({
    run: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === "remove") throw new Error("Worktree changed");
      if (args.includes("--target-only")) return report([fresh], tree.path);
      return report([tree, other]);
    },
  });
  await backend.configureWorkspace(
    { host: "vps", root: "/work", github: true, fetch: true },
    async () => {},
  );
  await backend.waitUntilIdle();
  const oldRevision = backend.getState().revision;
  const result = await backend.remove(selection(backend));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, [
    "list",
    "--target-only",
    "--linked-only",
    "--json",
    "--path",
    tree.path,
    "--host",
    "vps",
    "--github",
  ]);
  assert.equal(calls[2].options.timeout, 30000);
  assert.equal(calls[2].args.includes("--fetch"), false);
  assert.notEqual(result.revision, oldRevision);
  assert.equal(result.report.worktrees[0].head, fresh.head);
  assert.equal(result.report.worktrees[0].canDiscard, true);
  assert.equal(result.report.worktrees[0].lastRemovalError, "Worktree changed");
  assert.deepEqual(result.report.worktrees[1], other);
  assert.equal(result.results[0].removed, false);
});

test("inspection retry authenticates the current row and never retries deletion", async () => {
  const calls = [];
  let fails = true;
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "remove") throw new Error("Changed");
      if (args.includes("--target-only") && fails)
        throw new Error("Disconnected");
      return report();
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  await backend.remove(selection(backend));
  assert.equal(backend.getState().report.worktrees[0].retryInspection, true);
  assert.throws(
    () => backend.inspectWorktree({ id: tree.id, revision: "old" }),
    /list changed/,
  );
  const before = backend.getState().revision;
  fails = false;
  const state = backend.inspectWorktree({
    id: tree.id,
    revision: before,
    path: "/arbitrary",
  });
  assert.equal(state.busy, true);
  await backend.waitUntilIdle();
  assert.notEqual(backend.getState().revision, before);
  assert.equal(backend.getState().report.worktrees[0].canRemove, true);
  assert.equal(backend.getState().report.worktrees[0].retryInspection, false);
  assert.equal(calls.filter((args) => args[0] === "remove").length, 1);
  assert.equal(calls.at(-1)[calls.at(-1).indexOf("--path") + 1], tree.path);
});

test("finish-current quit cancels read-only failure inspection without retrying deletion", async () => {
  let inspectionStarted;
  const started = new Promise((resolve) => {
    inspectionStarted = resolve;
  });
  const calls = [];
  const backend = new Backend({
    run: async (args, options) => {
      calls.push(args);
      if (args[0] === "remove") throw new Error("Changed");
      if (args.includes("--target-only"))
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Inspection stopped")),
            { once: true },
          );
          inspectionStarted();
        });
      return report();
    },
  });
  await backend.configureWorkspace({}, async () => {});
  await backend.waitUntilIdle();
  const pending = backend.remove(selection(backend));
  await started;
  backend.requestClose({ finishCleanup: true });
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.report.worktrees[0].retryInspection, true);
  assert.equal(calls.length, 3);
  assert.equal(backend.getState().busy, false);
});

test("missing worktree deletion and targeted retry forward the repository hint as one argument", async () => {
  const missing = {
    ...tree,
    commonDir: "/code/repo's data/.git",
    missing: true,
    locked: true,
    canRemove: false,
    canDiscard: true,
    recommended: false,
  };
  const calls = [];
  const backend = new Backend({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "remove") throw new Error("Fixture removal failure");
      return report([missing]);
    },
  });
  await backend.configureWorkspace(
    { host: "vps", root: "/work" },
    async () => {},
  );
  await backend.waitUntilIdle();
  await backend.remove(
    selection(backend, { discardLocal: true, recommendedOnly: false }),
    async () => true,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1][calls[1].indexOf("--repo") + 1], missing.commonDir);
  assert.equal(calls[1].includes("--discard-local"), true);
  assert.equal(calls[2][calls[2].indexOf("--repo") + 1], missing.commonDir);
  assert.equal(calls[2].includes("--target-only"), true);
});
