"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("tree projection preserves hierarchy while filtering and sorting", async () => {
  const { projectTree } = await import("../renderer/worktree-presentation.mjs");
  const tree = require("./worktree-tree.mjs");
  const list = [
    {
      id: "small",
      path: "/work/team/small",
      branch: "small",
      repo: "repo",
      sizeBytes: 1,
    },
    {
      id: "large",
      path: "/work/team/large",
      branch: "large",
      repo: "repo",
      sizeBytes: 20,
    },
    {
      id: "other",
      path: "/work/other/tree",
      branch: "other",
      repo: "repo",
      sizeBytes: 10,
    },
  ];
  const options = {
    root: "/work",
    hostFilter: "",
    hosts: [],
    repo: "",
    view: "all",
    search: "",
    sort: "size",
    descending: true,
    collapsedDirectories: new Set(),
  };
  const projected = projectTree(list, options, tree);
  assert.deepEqual(
    projected.visible.map((row) => row.id),
    ["large", "small", "other"],
  );
  const collapsed = projectTree(
    list,
    {
      ...options,
      collapsedDirectories: new Set([JSON.stringify(["", "/work/team"])]),
    },
    tree,
  );
  assert.deepEqual(
    collapsed.visible.map((row) => row.id),
    ["other"],
  );
  const filtered = projectTree(list, { ...options, search: "  LARGE  " }, tree);
  assert.deepEqual(
    filtered.filtered.map((row) => row.id),
    ["large"],
  );
  assert.deepEqual(
    list.map((row) => row.id),
    ["small", "large", "other"],
    "projection never rearranges report data",
  );
});

test("same-path rows sort independently and keep exact delete/selection identities", async () => {
  const { projectTree, renderTreeRows } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const tree = require("./worktree-tree.mjs");
  const list = [
    {
      id: "original",
      path: "/work/shared",
      repo: "z",
      branch: "z",
      sizeBytes: 1,
      activityAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "copy",
      path: "/work/shared",
      repo: "a",
      branch: "a",
      sizeBytes: 2,
      activityAt: "2026-01-02T00:00:00Z",
    },
  ];
  for (const [sort, descending] of [
    ["branch", false],
    ["repo", false],
    ["size", true],
    ["activity", true],
  ]) {
    const result = projectTree(
      list,
      {
        root: "/work",
        hostFilter: "",
        hosts: [],
        search: "",
        view: "all",
        sort,
        descending,
        collapsedDirectories: new Set(),
      },
      tree,
    );
    assert.deepEqual(
      result.visible.map((row) => row.id),
      ["copy", "original"],
      sort,
    );
    const markup = renderTreeRows(result.directoryRows, {
      selected: new Set(["copy"]),
      collapsed: new Set(),
      disabled: false,
    });
    assert.match(markup, /2 worktrees/);
    assert.match(markup, /class="worktree-row selected"[^>]+data-id="copy"/);
    assert.match(markup, /class="worktree-row"[^>]+data-id="original"/);
    assert.match(markup, /data-delete="copy"/);
    assert.match(markup, /data-delete="original"/);
  }
});

test("tree markup escapes metadata and distinguishes missing/pending checkouts", async () => {
  const { renderTreeRows } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const row = {
    kind: "worktree",
    label: "<topic>",
    pathPrefix: "/work/<parent>",
    depth: 1,
    worktree: {
      id: 'id"unsafe',
      path: "/work/<topic>",
      branch: '<script>alert("no")</script>',
      repo: '<repo>&"',
      sizeBytes: 0,
      missing: true,
      canDiscard: true,
    },
  };
  const options = {
    selected: new Set(['id"unsafe']),
    collapsed: new Set(),
    disabled: true,
    cancelled: false,
  };
  const markup = renderTreeRows([row], options);
  const escapedContext =
    "Missing checkout · &lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt; · &lt;repo&gt;&amp;&quot;";
  assert.ok(markup.includes(`title="${escapedContext}"`));
  assert.ok(
    markup.includes(
      '<span class="worktree-state" data-tone="muted" title="The folder is gone. Only its Git registration remains.">Missing checkout</span> · &lt;script&gt;',
    ),
  );
  assert.ok(markup.includes('id="worktree-row-id&quot;unsafe"'));
  assert.doesNotMatch(markup, /<script>|data-id="id"unsafe/);
  assert.match(markup, /Missing checkout/);
  assert.match(markup, /class="size-cell">—</);
  assert.match(markup, /aria-selected="true"/);
  assert.match(markup, /data-delete="id&amp;|data-delete="id&quot;unsafe"/);
  assert.match(markup, /disabled>Delete/);
  for (const expected of [
    'data-path="/work/&lt;topic&gt;"',
    'title="/work/&lt;topic&gt;"',
    'aria-label="/work/&lt;topic&gt;"',
    '<span class="path-parent">/work/&lt;parent&gt;/</span>',
    '<span class="path-basename">&lt;topic&gt;</span>',
    'data-id="id&quot;unsafe"',
    'data-worktree-menu="id&quot;unsafe"',
    'aria-label="Actions for /work/&lt;topic&gt;"',
    'aria-label="Delete /work/&lt;topic&gt;"',
    "&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt; · &lt;repo&gt;&amp;&quot;",
  ])
    assert.ok(markup.includes(expected), `missing escaped markup: ${expected}`);
  assert.match(
    renderTreeRows([{ ...row, worktree: { ...row.worktree, pending: true } }], {
      ...options,
      cancelled: true,
    }),
    /Scan incomplete/,
  );
});

test("a row states the one fact that decides cleanup, and stays quiet otherwise", async () => {
  const { worktreeState, renderTreeRows } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const removable = { canRemove: true, canDiscard: true };
  const discardable = { canRemove: false, canDiscard: true };
  for (const [row, tone, label] of [
    [{ ...removable }, null],
    [{ ...removable, pending: true, merged: true }, null],
    [{ ...removable, merged: true, recommended: true }, "safe", "Merged"],
    // Ancestry alone is not finished work in a checkout created moments ago.
    [{ ...removable, merged: true, fresh: true }, "muted", "New"],
    [{ ...discardable, locked: true, merged: true }, "muted", "Locked"],
    [{ ...discardable, ignored: true, merged: true }, "caution", "Ignored files"],
    [
      { ...discardable, dirty: true, changedFiles: 1, ignored: true },
      "caution",
      "1 uncommitted change",
    ],
    [
      { ...discardable, dirty: true, changedFiles: 12 },
      "caution",
      "12 uncommitted changes",
    ],
    [{ ...discardable, empty: true }, "muted", "Empty checkout"],
    [{ blockers: ["Contains submodules"] }, "blocked", "Contains submodules"],
    [
      { blockers: ["Inspection failed: ssh: timeout. Use Retry Inspection."] },
      "blocked",
      "Inspection failed",
    ],
    [
      { blockers: ["Uncommitted or untracked files"], problems: ["git: fatal"] },
      "blocked",
      "Cannot be deleted",
    ],
  ]) {
    const state = worktreeState(row);
    assert.equal(state?.tone ?? null, tone, JSON.stringify(row));
    if (tone) assert.equal(state.label, label);
  }
  assert.equal(
    worktreeState({ blockers: ["One"], problems: ["<two>"] }).detail,
    "One\n<two>",
  );
  const markup = renderTreeRows(
    [
      {
        kind: "worktree",
        label: "topic",
        pathPrefix: "/work",
        depth: 1,
        worktree: {
          ...discardable,
          id: "dirty",
          path: "/work/topic",
          branch: "topic",
          repo: "repo",
          locked: true,
          lockReason: '<held> & "kept"',
        },
      },
    ],
    { selected: new Set(), collapsed: new Set(), disabled: false },
  );
  assert.ok(
    markup.includes(
      '<span class="worktree-state" data-tone="muted" title="&lt;held&gt; &amp; &quot;kept&quot;">Locked</span> · topic · repo',
    ),
  );
  assert.ok(markup.includes('title="Locked · topic · repo"'));
});

test("repository sidebar and directory group escape names and every path attribute", async () => {
  const { renderRepositoryList, renderTreeRows } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const sidebar = renderRepositoryList(
    [{ id: 'repo"identifier', name: '<repo>&"', count: 1 }],
    'repo"identifier',
  );
  for (const expected of [
    'data-repo="repo&quot;identifier"',
    'title="repo&quot;identifier"',
    "<span>&lt;repo&gt;&amp;&quot;</span>",
  ])
    assert.ok(
      sidebar.includes(expected),
      `missing escaped sidebar: ${expected}`,
    );
  const group = renderTreeRows(
    [
      {
        kind: "directory",
        depth: 1,
        label: '<folder>&"',
        node: { path: '/work/<folder>"', descendants: [{}] },
      },
    ],
    { selected: new Set(), collapsed: new Set(), disabled: false },
  );
  for (const expected of [
    'data-directory-path="/work/&lt;folder&gt;&quot;"',
    'data-toggle-directory="/work/&lt;folder&gt;&quot;"',
    'data-folder-delete="/work/&lt;folder&gt;&quot;"',
    'title="/work/&lt;folder&gt;&quot;"',
    'aria-label="Collapse /work/&lt;folder&gt;&quot;"',
    "&lt;folder&gt;&amp;&quot;</span>",
  ])
    assert.ok(
      group.includes(expected),
      `missing escaped directory: ${expected}`,
    );
});

test("selection reconciles provisional IDs by path and clears vanished anchors", async () => {
  const { reconcileSelection } = await import("../renderer/selection.mjs");
  const previous = [
    { id: "pending", path: "/one", pending: true },
    { id: "gone", path: "/two" },
  ];
  const next = [{ id: "registered", path: "/one" }];
  const before = {
    ids: new Set(["pending", "gone"]),
    anchor: "gone",
    cursor: "pending",
  };
  const actual = reconcileSelection(previous, next, before);
  assert.deepEqual([...actual.ids], ["registered"]);
  assert.equal(actual.anchor, "");
  assert.equal(actual.cursor, "registered");
  assert.deepEqual(
    [...before.ids],
    ["pending", "gone"],
    "reconciliation is pure",
  );
  assert.deepEqual(reconcileSelection(previous, next, before, false), {
    ids: new Set(),
    anchor: "",
    cursor: "",
  });
});

test("selection shift ranges and additive toggles use visible tree order", async () => {
  const { selectRow } = await import("../renderer/selection.mjs");
  const rows = ["a", "c", "b"].map((id) => ({ id }));
  let value = selectRow({ ids: new Set(), anchor: "", cursor: "" }, rows, "a");
  value = selectRow(value, rows, "b", { shiftKey: true });
  assert.deepEqual([...value.ids], ["a", "c", "b"]);
  assert.equal(value.anchor, "a");
  value = selectRow(value, rows, "c", { metaKey: true });
  assert.deepEqual([...value.ids], ["a", "b"]);
  assert.equal(value.anchor, "c");
  value = selectRow(value, rows, "b", { shiftKey: true, ctrlKey: true });
  assert.deepEqual([...value.ids], ["a", "b", "c"]);
  const backward = selectRow(
    { ids: new Set(["b"]), anchor: "b", cursor: "b" },
    rows,
    "a",
    { shiftKey: true },
  );
  assert.deepEqual([...backward.ids], ["a", "c", "b"]);
  assert.equal(backward.anchor, "b");
});

test("selection preserves exact registration IDs and never expands duplicate paths", async () => {
  const { reconcileSelection } = await import("../renderer/selection.mjs");
  const rows = [
    { id: "repo-a", path: "/shared" },
    { id: "repo-b", path: "/shared" },
  ];
  const selection = {
    ids: new Set(["repo-b"]),
    anchor: "repo-b",
    cursor: "repo-b",
  };
  const kept = reconcileSelection(rows, [...rows].reverse(), selection);
  assert.deepEqual([...kept.ids], ["repo-b"]);
  assert.equal(kept.anchor, "repo-b");
  assert.equal(kept.cursor, "repo-b");
  const removed = reconcileSelection(rows, [rows[0]], selection);
  assert.deepEqual([...removed.ids], []);
  assert.equal(removed.anchor, "");
  assert.equal(removed.cursor, "");
  const provisional = [{ id: "pending", path: "/shared", pending: true }];
  const ambiguous = reconcileSelection(provisional, rows, {
    ids: new Set(["pending"]),
    anchor: "pending",
    cursor: "pending",
  });
  assert.deepEqual([...ambiguous.ids], []);
  const replacement = reconcileSelection([rows[1]], [rows[0]], selection);
  assert.deepEqual(
    [...replacement.ids],
    [],
    "a new registration at an old path is not a provisional-ID replacement",
  );
});

test("exclusion editor preserves literal commas and patterns", async () => {
  const { readExcludes } = await import("../renderer/input-values.mjs");
  assert.deepEqual(
    readExcludes({
      value: "  name,with,commas\r\n\n ~/.codex*/.tmp \n **/build ",
    }),
    ["name,with,commas", "~/.codex*/.tmp", "**/build"],
  );
});

test("setup owns draft machine roots, steps, and duplicate submission guard", async () => {
  const { createSetupController } = await import(
    "../renderer/setup-controller.mjs"
  );
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector))
      elements.set(selector, {
        value: "",
        checked: false,
        hidden: false,
        open: false,
        dataset: {},
        selectedOptions: [{ textContent: "System" }],
        focus() {},
        reportValidity() {},
        addEventListener() {},
        reset() {},
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return elements.get(selector);
  };
  const document = { querySelector: element, querySelectorAll: () => [] };
  const request = deferred(),
    calls = [];
  const controller = createSetupController({
    document,
    api: {},
    defaults: { excludes: ["cache"] },
    onThemeChange() {},
    async onSubmit(options) {
      calls.push(options);
      await request.promise;
    },
  });
  controller.setContext({
    required: true,
    root: "/local",
    resetting: false,
    theme: "system",
    excludes: ["cache"],
  });
  controller.open();
  assert.equal(element("#setup-root").value, "/local");
  element("#setup-remote").checked = true;
  element("#setup-remote").onchange();
  assert.equal(element("#setup-root").value, "~");
  element("#setup-root").value = "/remote";
  element("#setup-remote").checked = false;
  element("#setup-local").onchange();
  assert.equal(element("#setup-root").value, "/local");
  element("#setup-next").onclick();
  element("#setup-next").onclick();
  assert.equal(element("#setup-dialog").dataset.step, "3");
  const first = element("#setup-form").onsubmit({ preventDefault() {} });
  const duplicate = element("#setup-form").onsubmit({ preventDefault() {} });
  await duplicate;
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(element("#setup-start").disabled, true);
  request.resolve();
  await first;
  assert.equal(element("#setup-dialog").open, false);
  assert.equal(element("#setup-start").disabled, false);
  controller.reset();
  assert.equal(element("#setup-start").textContent, "Start scanning");
});

function dialogFixture({ deferredClose = false } = {}) {
  const content = { innerHTML: "" },
    footer = { textContent: "" },
    listeners = {};
  const dialog = {
    open: false,
    showModal() {
      this.open = true;
    },
    addEventListener(name, fn) {
      listeners[name] = fn;
    },
    close() {
      this.open = false;
      if (!deferredClose) listeners.close?.();
    },
  };
  const document = {
    querySelector: (selector) =>
      ({
        "#statistics-dialog": dialog,
        "#statistics-content": content,
        "#statistics-dialog .statistics-footer": footer,
      })[selector],
  };
  return {
    document,
    dialog,
    content,
    footer,
    dispatchClose: () => listeners.close?.(),
  };
}
const statsReport = (removedWorktrees) => ({
  version: 1,
  removedWorktrees,
  estimatedBytesReclaimed: 1024,
  missingRegistrations: 0,
  cleanupSessions: 1,
  largestWorktreeBytes: 1024,
  detachedCommitsRetained: 0,
  daily: [],
});

test("statistics opening owns its async response, including stale errors", async () => {
  const { createStatisticsController } = await import(
    "../renderer/statistics-controller.mjs"
  );
  const fixture = dialogFixture(),
    first = deferred(),
    second = deferred();
  const requests = [first, second];
  const controller = createStatisticsController({
    document: fixture.document,
    getHost: () => "",
    api: { getStats: () => requests.shift().promise },
  });
  const opening = controller.open();
  fixture.dialog.close();
  const reopened = controller.open();
  second.resolve({ host: "", report: statsReport(7) });
  await reopened;
  assert.match(fixture.content.innerHTML, /data-stat="removedWorktrees">7</);
  const rendered = fixture.content.innerHTML;
  first.reject(new Error("stale failed request"));
  await opening;
  assert.equal(fixture.content.innerHTML, rendered);
});

test("a queued close event cannot invalidate a reopened statistics dialog", async () => {
  const { createStatisticsController } = await import(
    "../renderer/statistics-controller.mjs"
  );
  const fixture = dialogFixture({ deferredClose: true });
  const first = deferred(),
    second = deferred();
  const requests = [first, second];
  const controller = createStatisticsController({
    document: fixture.document,
    getHost: () => "",
    api: { getStats: () => requests.shift().promise },
  });
  const opening = controller.open();
  fixture.dialog.close();
  const reopened = controller.open();
  fixture.dispatchClose();
  second.resolve({ host: "", report: statsReport(12) });
  await reopened;
  assert.equal(fixture.dialog.open, true);
  assert.match(fixture.content.innerHTML, /data-stat="removedWorktrees">12</);
  const rendered = fixture.content.innerHTML;
  first.resolve({ host: "", report: statsReport(99) });
  await opening;
  assert.equal(fixture.content.innerHTML, rendered);
});

test("statistics never retitles old-machine data or errors after a host switch", async () => {
  const { createStatisticsController } = await import(
    "../renderer/statistics-controller.mjs"
  );
  for (const fail of [false, true]) {
    const fixture = dialogFixture(),
      request = deferred();
    let host = "vps-one";
    const controller = createStatisticsController({
      document: fixture.document,
      getHost: () => host,
      api: { getStats: () => request.promise },
    });
    const pending = controller.open();
    host = "vps-two";
    if (fail) request.reject(new Error("old machine error"));
    else request.resolve({ host: "vps-one", report: statsReport(99) });
    await pending;
    assert.match(fixture.content.innerHTML, /Loading statistics/);
    assert.doesNotMatch(fixture.content.innerHTML, /99|old machine/);
  }
});

function coordinatorState(changes = {}) {
  const { hosts: _hosts, hostFilter: _hostFilter, ...sourceChanges } = changes;
  const source = {
    host: "",
    root: "/local",
    busy: false,
    error: "",
    warning: "",
    options: { root: "/local", host: "", excludes: [] },
    report: { worktrees: [], warnings: [] },
    ...sourceChanges,
  };
  source.options = changes.options || {
    root: source.root,
    host: source.host,
    excludes: [],
  };
  return {
    ...source,
    revision: changes.revision || "initial",
    hostFilter: Object.hasOwn(changes, "hostFilter")
      ? changes.hostFilter
      : source.host,
    hosts: [
      {
        ...source,
        report: source.report && { root: source.root },
        worktreeCount: source.report?.worktrees.length || 0,
      },
    ],
  };
}

async function workspaceFixture(overrides = {}) {
  const { createWorkspaceController } = await import(
    "../renderer/workspace-controller.mjs"
  );
  let timerID = 0;
  const pendingTimers = new Map(),
    savedScans = [],
    notifications = [];
  const initial = coordinatorState();
  const api = {
    async getState() {
      return initial;
    },
    ...overrides,
  };
  const workspace = createWorkspaceController({
    api,
    onScanAccepted(options) {
      savedScans.push(options);
    },
    linked: (rows) => rows,
    notify: (...args) => notifications.push(args),
    onChange() {},
    onSetup() {},
    onHostChange() {},
    onReset() {},
    timers: {
      setTimeout(fn) {
        pendingTimers.set(++timerID, fn);
        return timerID;
      },
      clearTimeout(id) {
        pendingTimers.delete(id);
      },
    },
  });
  await workspace.initialize();
  return { workspace, api, savedScans, pendingTimers, initial, notifications };
}

test("settings warnings stay visible without failing scans and errors take priority", async () => {
  const { createWorkspaceView } = await import(
    "../renderer/workspace-view.mjs"
  );
  const warning =
    "Could not save settings: read-only profile. These choices will be used for this session.";
  const scans = [],
    refreshes = [],
    options = {
      root: "/session",
      host: "",
      excludes: ["custom"],
      github: true,
    };
  const response = coordinatorState({ root: options.root, options, warning });
  const fixture = await workspaceFixture({
    async scan(value) {
      scans.push(value);
      return response;
    },
    async refreshHosts(host) {
      refreshes.push(host);
      return response;
    },
  });
  const { document, element } = preferenceDocument();
  const view = createWorkspaceView({ document, workspace: fixture.workspace });
  await fixture.workspace.scan(options);
  view.render();
  assert.equal(fixture.workspace.error, "");
  assert.equal(fixture.workspace.blocked, false);
  assert.equal(element("#error-banner").hidden, false);
  assert.equal(element("#error-banner").dataset.kind, "warning");
  assert.equal(element("#error-banner").attributes.role, "status");
  assert.equal(element("#error-message").textContent, warning);
  assert.equal(
    element("#dismiss-error").attributes["aria-label"],
    "Dismiss warning",
  );
  fixture.workspace.showError("Operation failed");
  view.render();
  assert.equal(element("#error-message").textContent, "Operation failed");
  assert.equal(element("#error-banner").attributes.role, "alert");
  assert.equal(element("#error-banner").dataset.kind, "error");
  element("#dismiss-error").onclick();
  view.render();
  assert.equal(element("#error-message").textContent, warning);
  element("#dismiss-error").onclick();
  view.render();
  assert.equal(element("#error-banner").hidden, true);
  await fixture.workspace.refresh();
  assert.deepEqual(
    scans,
    [options],
    "refresh does not configure another scan or overwrite its session options",
  );
  assert.deepEqual(refreshes, [""]);
  assert.deepEqual(fixture.workspace.snapshot.options, options);
  view.render();
  assert.equal(element("#error-message").textContent, warning);
  assert.equal(element("#error-banner").hidden, false);
  fixture.workspace.dispose();
});

test("workspace chrome stops coordinator scans and reset publishes a clean coordinator state", async () => {
  const { createWorkspaceView } = await import(
    "../renderer/workspace-view.mjs"
  );
  const cached = {
    id: '["vps","cached"]',
    host: "vps",
    sourceID: "cached",
    path: "/work/cached",
    head: "abc",
    canRemove: true,
  };
  const scanning = coordinatorState({
    host: "vps",
    root: "/work",
    busy: true,
    canCancelScan: true,
    report: { worktrees: [cached], warnings: [] },
    progress: {
      stage: "inspect",
      path: "/work/current",
      completed: 1,
      total: 2,
    },
  });
  const stopped = coordinatorState({
    ...scanning,
    busy: false,
    canCancelScan: false,
    cancelled: true,
  });
  const resetState = coordinatorState({ report: null, setupRequired: true });
  const stops = [];
  const fixture = await workspaceFixture({
    async getState() {
      return scanning;
    },
    async cancelScan(host) {
      stops.push(host);
      return stopped;
    },
    async resetPreferences() {
      return { state: resetState, preferences: {} };
    },
  });
  const { document, element } = preferenceDocument();
  const view = createWorkspaceView({ document, workspace: fixture.workspace });
  view.render();
  assert.equal(element("#scan-progress").hidden, false);
  assert.match(
    element("#host-progress-list").innerHTML,
    /data-stop-host="vps"/,
  );
  assert.equal(element("#stop-scan").textContent, "Stop all scans");
  assert.equal(
    fixture.workspace.canDelete(cached),
    true,
    "cached rows remain usable while refreshing",
  );
  await element("#stop-scan").onclick();
  assert.deepEqual(stops, [null]);
  view.render();
  assert.match(element("#host-progress-list").innerHTML, /Scan stopped/);
  assert.equal(fixture.workspace.canDelete(cached), true);
  await fixture.workspace.reset();
  view.render();
  assert.equal(fixture.workspace.snapshot.setupRequired, true);
  assert.deepEqual(fixture.workspace.items, []);
  assert.equal(fixture.workspace.blocked, true);
  assert.equal(element("#scan-progress").hidden, true);
  fixture.workspace.dispose();
});

test("workspace publishes cached immutable snapshots with nested mutation isolation", async () => {
  const row = {
    id: "tree",
    path: "/local/tree",
    branch: "topic",
    head: "abc",
    blockers: ["keep"],
    pr: { title: "original", merged: false },
  };
  const incoming = coordinatorState({
    host: "",
    root: "/local",
    busy: false,
    revision: "first",
    report: { worktrees: [row], warnings: [] },
    options: { excludes: ["cache"] },
    progress: { worktree: row },
  });
  const scan = deferred();
  const fixture = await workspaceFixture({
    getState: async () => incoming,
    scan: () => scan.promise,
  });
  const snapshot = fixture.workspace.snapshot,
    items = fixture.workspace.items;
  assert.equal(
    snapshot,
    fixture.workspace.snapshot,
    "reading a snapshot does not clone repeatedly",
  );
  assert.equal(items, fixture.workspace.items);
  assert.equal(items[0], snapshot.report.worktrees[0]);
  for (const mutate of [
    () => {
      snapshot.root = "/changed";
    },
    () => {
      snapshot.report.worktrees[0].canRemove = true;
    },
    () => {
      snapshot.report.worktrees[0].pr.title = "changed";
    },
    () => snapshot.report.worktrees[0].blockers.push("changed"),
    () => snapshot.options.excludes.push("changed"),
    () => snapshot.hosts[0].options.excludes.push("changed"),
    () => {
      snapshot.hosts[0].report.root = "/changed";
    },
    () => {
      snapshot.progress.worktree.branch = "changed";
    },
    () => items.push(row),
  ])
    assert.throws(mutate, TypeError);
  row.pr.title = "source changed";
  incoming.options.excludes.push("external");
  assert.equal(snapshot.report.worktrees[0].pr.title, "original");
  assert.deepEqual(snapshot.options.excludes, ["cache"]);
  fixture.workspace.showError("display-only update");
  assert.equal(
    fixture.workspace.items,
    items,
    "unchanged report rows reuse their immutable publication",
  );
  const pending = fixture.workspace.scan({ host: "", root: "/next" });
  assert.equal(
    snapshot.busy,
    false,
    "previous publication cannot change later",
  );
  assert.equal(fixture.workspace.snapshot.busy, true);
  scan.resolve(
    coordinatorState({
      host: "",
      root: "/next",
      busy: false,
      report: { worktrees: [{ ...row, branch: "next" }], warnings: [] },
    }),
  );
  await pending;
  assert.equal(snapshot.report.worktrees[0].branch, "topic");
  assert.equal(fixture.workspace.items[0].branch, "next");
  assert.ok(Object.isFrozen(fixture.workspace.items[0].pr));
  fixture.workspace.dispose();
});

function preferenceDocument() {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector))
      elements.set(selector, {
        value: "",
        checked: false,
        hidden: false,
        disabled: false,
        open: false,
        dataset: {},
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        removeAttribute(name) {
          delete this.attributes[name];
        },
        selectedOptions: [{ textContent: "System" }],
        addEventListener() {},
        querySelectorAll() {
          return [];
        },
        focus() {},
        reportValidity() {},
        reset() {},
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return elements.get(selector);
  };
  return {
    element,
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      documentElement: { dataset: {} },
      body: { classList: { toggle() {} } },
    },
  };
}

test("workspace labels have single owners and tree rendering never touches them", async () => {
  const { createPreferencesController } = await import(
    "../renderer/preferences-controller.mjs"
  );
  const { createWorkspaceView } = await import(
    "../renderer/workspace-view.mjs"
  );
  const { createWorktreeView } = await import("../renderer/worktree-view.mjs");
  const fixture = await workspaceFixture({
    getState: async () =>
      coordinatorState({
        host: "build-vps",
        root: "/sessions",
        version: "test-version",
        busy: false,
        report: { worktrees: [], warnings: [] },
      }),
  });
  const { document, element } = preferenceDocument();
  const visited = new Set();
  document.querySelector = (selector) => {
    visited.add(selector);
    return element(selector);
  };
  const preferences = createPreferencesController({
    document,
    api: {},
    defaults: { excludes: [] },
    notify() {},
  });
  const chrome = createWorkspaceView({
    document,
    workspace: fixture.workspace,
  });
  const trees = createWorktreeView({
    document,
    workspace: fixture.workspace,
    tree: require("./worktree-tree.mjs"),
    showWorktreeMenu() {},
  });
  visited.clear();
  trees.render();
  for (const selector of [
    "#machine-label",
    "#root-label",
    "#path-button",
    "#window-context",
    "#connection-label",
    "#version",
  ])
    assert.equal(visited.has(selector), false, `tree must not own ${selector}`);
  visited.clear();
  preferences.renderStatus(
    coordinatorState({ host: "build-vps", root: "/sessions" }),
  );
  assert.equal(element("#machine-label").textContent, "build-vps");
  assert.equal(element("#machine-label").title, "build-vps");
  assert.equal(element("#root-label").textContent, "build-vps:/sessions");
  assert.equal(
    element("#path-button").title,
    "Scan folder: build-vps:/sessions",
  );
  for (const selector of ["#window-context", "#connection-label", "#version"])
    assert.equal(
      visited.has(selector),
      false,
      `preferences must not own ${selector}`,
    );
  visited.clear();
  chrome.render();
  assert.equal(element("#window-context").textContent, "build-vps — Arbor");
  assert.equal(element("#connection-label").textContent, "SSH workspace");
  assert.equal(element("#version").textContent, "test-version");
  for (const selector of ["#machine-label", "#root-label", "#path-button"])
    assert.equal(
      visited.has(selector),
      false,
      `workspace chrome must not own ${selector}`,
    );
  preferences.renderStatus(coordinatorState({ host: "", root: "" }));
  assert.equal(element("#machine-label").textContent, "This computer");
  assert.equal(element("#root-label").textContent, "Home folder");
  fixture.workspace.dispose();
});

test("Add Host, setup and protocol share SSH alias, IPv6 and length validation", async () => {
  const { isValidSSHHost, MAX_HOST_LENGTH, MAX_HOST_LABEL_LENGTH } =
    await import("./ssh-host.mjs");
  const { createPreferencesController } = await import(
    "../renderer/preferences-controller.mjs"
  );
  const { createSetupController } = await import(
    "../renderer/setup-controller.mjs"
  );
  const { scanOptions, validatePreferences } = require("../protocol.cjs");
  for (const host of [
    "_build",
    "user@[2001:db8::1]",
    "host.example",
    "a".repeat(255),
    "a".repeat(256),
    "",
    "-oOption",
    "host extra",
    "host\nother",
    "host\0other",
  ]) {
    const expected =
      host !== "" &&
      (() => {
        try {
          scanOptions({ host });
          return true;
        } catch {
          return false;
        }
      })();
    assert.equal(
      isValidSSHHost(host),
      expected,
      `shared predicate for ${JSON.stringify(host)}`,
    );
    const { element, document } = preferenceDocument();
    const commands = [],
      writes = [],
      notices = [];
    const preferences = createPreferencesController({
      document,
      defaults: { excludes: [] },
      notify: (...args) => notices.push(args),
      onScan() {},
      onSetup() {},
      onReset() {},
      onHostChange: (options) => commands.push(options),
      api: {
        async savePreferences(value) {
          validatePreferences(value);
          writes.push(value);
        },
      },
    });
    preferences.renderStatus(
      coordinatorState({
        host: "",
        root: "/local",
        connected: true,
        blocked: false,
        options: { excludes: [] },
      }),
    );
    element("#host-input").value = host;
    await element("#host-form").onsubmit({ preventDefault() {} });
    assert.equal(
      commands.length,
      expected ? 1 : 0,
      `Add Host parity for ${JSON.stringify(host)}`,
    );
    assert.equal(writes.length, expected ? 1 : 0);
    assert.equal(element("#host-input").maxLength, MAX_HOST_LENGTH);
    if (expected) {
      assert.equal(writes[0].hosts[0].host, host);
      assert.ok(writes[0].hosts[0].name.length <= MAX_HOST_LABEL_LENGTH);
    }
    const setup = createSetupController({
      document,
      defaults: { excludes: [] },
      api: {},
      onSubmit() {},
      onThemeChange() {},
    });
    setup.setContext({
      required: true,
      root: "/local",
      theme: "system",
      excludes: [],
    });
    setup.open();
    element("#setup-remote").checked = true;
    element("#setup-host").value = host;
    element("#setup-next").onclick();
    assert.equal(
      element("#setup-dialog").dataset.step,
      expected ? "2" : "1",
      `setup parity for ${JSON.stringify(host)}`,
    );
    assert.equal(element("#setup-host").maxLength, MAX_HOST_LENGTH);
  }
  assert.equal(isValidSSHHost("", { allowLocal: true }), true);
  assert.equal(isValidSSHHost(null, { allowLocal: true }), false);
  for (const ending of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.equal(isValidSSHHost(`host${ending}`), false);
    assert.throws(() => scanOptions({ host: `host${ending}` }));
  }
});

test("settings emit one scan command and never persist scan options themselves", async () => {
  const { createPreferencesController } = await import(
    "../renderer/preferences-controller.mjs"
  );
  const { document, element } = preferenceDocument(),
    commands = [],
    writes = [];
  const preferences = createPreferencesController({
    document,
    defaults: { excludes: ["cache"] },
    api: {
      async savePreferences(value) {
        writes.push(value);
      },
    },
    notify() {},
    onScan: (options) => commands.push(options),
    onHostChange() {},
    onSetup() {},
    onReset() {},
  });
  preferences.initialize({ theme: "system", scan: { excludes: ["cache"] } });
  preferences.renderStatus(
    coordinatorState({
      host: "_build",
      root: "/work",
      connected: true,
      blocked: false,
      options: { excludes: ["cache"] },
    }),
  );
  preferences.openSettings();
  element("#theme-select").value = "dark";
  element("#scan-root").value = "/new";
  element("#scan-excludes").value = "**/build";
  await element("#settings-form").onsubmit({ preventDefault() {} });
  assert.equal(writes.length, 0);
  assert.deepEqual(commands, [
    {
      root: "/new",
      host: "_build",
      github: false,
      fetch: false,
      excludes: ["**/build"],
      theme: "dark",
    },
  ]);
  assert.deepEqual(
    preferences.options.excludes,
    ["cache"],
    "active options remain backend-owned until its next snapshot",
  );
});

test("workspace ignores a poll from before an explicit scan", async () => {
  const oldPoll = deferred(),
    newScan = deferred();
  const fixture = await workspaceFixture({ scan: () => newScan.promise });
  fixture.api.getState = () => oldPoll.promise;
  const poll = [...fixture.pendingTimers.values()][0]();
  const scan = fixture.workspace.scan({ root: "/new", host: "" });
  oldPoll.resolve(
    coordinatorState({ root: "/stale", busy: false, revision: "stale" }),
  );
  await poll;
  assert.equal(fixture.workspace.snapshot.busy, true);
  assert.notEqual(fixture.workspace.snapshot.root, "/stale");
  newScan.resolve(
    coordinatorState({ root: "/new", host: "", busy: false, revision: "new" }),
  );
  await scan;
  assert.equal(fixture.workspace.snapshot.root, "/new");
  assert.equal(fixture.savedScans.length, 1);
  fixture.workspace.dispose();
});

test("later host filter wins over an older asynchronous reply without scanning", async () => {
  const old = deferred(),
    latest = deferred(),
    requests = [old, latest];
  const fixture = await workspaceFixture({
    setHostFilter: () => requests.shift().promise,
  });
  const first = fixture.workspace.setHostFilter("one");
  const second = fixture.workspace.setHostFilter("two");
  latest.resolve(
    coordinatorState({
      root: "/two",
      host: "two",
      busy: false,
      revision: "two",
    }),
  );
  await second;
  old.resolve(
    coordinatorState({
      root: "/one",
      host: "one",
      busy: false,
      revision: "one",
    }),
  );
  await first;
  assert.equal(fixture.workspace.snapshot.host, "two");
  assert.deepEqual(
    fixture.savedScans.map((options) => options.host),
    [],
  );
  fixture.workspace.dispose();
});

test("manual deletion keeps blockers, forwards discard consent, and settles once", async () => {
  const calls = [];
  const kept = { id: "kept", path: "/kept", pending: true };
  const eligible = {
    id: "delete",
    path: "/delete",
    head: "abc",
    canDiscard: true,
  };
  const fixture = await workspaceFixture({
    remove: async (selection) => {
      calls.push(selection);
      return {
        report: { worktrees: [kept] },
        revision: "after",
        results: [{ path: eligible.path, removed: true }],
      };
    },
  });
  fixture.api.getState = async () => ({
    ...fixture.initial,
    report: { worktrees: [kept] },
    revision: "after",
  });
  await fixture.workspace.deleteWorktrees([kept, eligible]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items, [{ id: "delete", head: "abc" }]);
  assert.equal(calls[0].forceConfirm, true);
  assert.equal(calls[0].discardLocal, true);
  assert.equal(fixture.workspace.removing, false);
  assert.equal(fixture.workspace.snapshot.revision, "after");
  assert.match(fixture.workspace.error, /\/kept: Scan again/);
  fixture.workspace.dispose();
});

test("a cleanup reports what it freed, counting only folders that existed", async () => {
  const rows = [
    { id: "a", path: "/work/a", head: "a", canRemove: true, sizeBytes: 2048 },
    { id: "b", path: "/work/b", head: "b", canRemove: true, sizeBytes: 1024 },
    {
      id: "gone",
      path: "/work/gone",
      head: "c",
      canDiscard: true,
      missing: true,
      sizeBytes: 4096,
    },
    { id: "kept", path: "/work/kept", head: "d", canRemove: true, sizeBytes: 9 },
  ];
  const fixture = await workspaceFixture({
    remove: async () => ({
      results: [
        { path: "/work/a", removed: true },
        { path: "/work/b", removed: true },
        { path: "/work/gone", removed: true },
        { path: "/work/kept", removed: false, error: "locked" },
      ],
    }),
  });
  await fixture.workspace.deleteWorktrees(rows);
  assert.deepEqual(fixture.notifications, [
    ["Deleted 3 worktrees, freeing 3 KB."],
  ]);
  assert.match(fixture.workspace.error, /\/work\/kept: locked/);
  fixture.notifications.length = 0;
  fixture.api.remove = async () => ({
    results: [{ path: "/work/gone", removed: true }],
  });
  await fixture.workspace.deleteWorktrees([rows[2]]);
  assert.deepEqual(fixture.notifications, [["Deleted 1 worktree."]]);
  fixture.workspace.dispose();
});

async function pollingFixture(onChange) {
  const { createWorkspaceController } = await import(
    "../renderer/workspace-controller.mjs"
  );
  const fixture = {
    state: coordinatorState({
      report: {
        worktrees: [{ id: "a", path: "/local/a", head: "a" }],
        warnings: [],
      },
    }),
    changes: 0,
    timers: new Map(),
  };
  let timerID = 0;
  fixture.workspace = createWorkspaceController({
    api: { getState: async () => structuredClone(fixture.state) },
    linked: (rows) => rows,
    notify() {},
    onChange() {
      fixture.changes++;
      onChange?.(fixture);
    },
    onSetup() {},
    onHostChange() {},
    onReset() {},
    timers: {
      setTimeout(fn) {
        fixture.timers.set(++timerID, fn);
        return timerID;
      },
      clearTimeout(id) {
        fixture.timers.delete(id);
      },
    },
  });
  // Each poll schedules exactly one successor; run the one that is waiting.
  fixture.poll = async () => {
    assert.equal(fixture.timers.size, 1, "exactly one poll is scheduled");
    const [[id, run]] = fixture.timers;
    fixture.timers.delete(id);
    await run();
  };
  await fixture.workspace.initialize();
  return fixture;
}

test("an idle workspace is not copied and redrawn on every identical poll", async () => {
  const fixture = await pollingFixture();
  await fixture.poll();
  const settled = fixture.changes,
    rows = fixture.workspace.items;
  await fixture.poll();
  await fixture.poll();
  assert.equal(fixture.changes, settled, "identical polls publish nothing");
  assert.equal(fixture.workspace.items, rows, "views keep the same snapshot");
  fixture.state = { ...fixture.state, revision: "next" };
  await fixture.poll();
  assert.equal(fixture.changes, settled + 1);
  assert.equal(fixture.workspace.snapshot.revision, "next");
  // A command result is always published, and so is the poll that follows it,
  // even when the backend has returned to a state seen before.
  await fixture.poll();
  const idle = fixture.changes;
  fixture.workspace.showError("failed");
  fixture.workspace.dismissError();
  assert.equal(fixture.changes, idle + 2);
  fixture.workspace.dispose();
});

test("polling continues after a snapshot that could not be drawn", async () => {
  let fail = false;
  const fixture = await pollingFixture(() => {
    if (fail) throw new TypeError("Cannot convert object to primitive value");
  });
  await fixture.poll();
  fail = true;
  fixture.state = { ...fixture.state, revision: "unrenderable" };
  await assert.rejects(fixture.poll(), /primitive value/);
  assert.equal(fixture.timers.size, 1, "the next poll is still scheduled");
  fail = false;
  fixture.state = { ...fixture.state, revision: "recovered" };
  await fixture.poll();
  assert.equal(fixture.workspace.snapshot.revision, "recovered");
  assert.equal(fixture.workspace.connected, true);
  fixture.workspace.dispose();
});

test("Delete merged acts on, counts, and describes exactly what the list shows", async () => {
  const { createWorkspaceView } = await import(
    "../renderer/workspace-view.mjs"
  );
  const row = (id, recommended, sizeBytes) => ({
    id,
    path: `/local/${id}`,
    head: id,
    canRemove: true,
    recommended,
    sizeBytes,
  });
  const all = [row("a", true, 1024), row("b", true, 2048), row("c", false, 1)];
  const removed = [];
  const fixture = await workspaceFixture({
    getState: async () =>
      coordinatorState({ report: { worktrees: all, warnings: [] } }),
    remove: async (selection) => {
      removed.push(selection);
      return { cancelled: true, results: [] };
    },
  });
  const { document, element } = preferenceDocument();
  let shown = { filtered: all, filtering: false };
  const view = createWorkspaceView({
    document,
    workspace: fixture.workspace,
    shown: () => shown,
  });
  view.render();
  assert.match(element("#cleanup-button").innerHTML, /Delete merged \(2\)/);
  assert.match(element("#cleanup-button").title, /2 recommended worktrees on/);
  // A search or repository filter narrows the action along with the list.
  shown = { filtered: [all[1], all[2]], filtering: true };
  view.renderControls();
  assert.match(element("#cleanup-button").innerHTML, /Delete merged \(1\)/);
  assert.match(
    element("#cleanup-button").title,
    /Remove 1 recommended worktree shown in this view and reclaim 2 KB/,
  );
  await element("#cleanup-button").onclick();
  assert.deepEqual(removed.at(-1).items, [{ id: "b", head: "b" }]);
  assert.equal(removed.at(-1).recommendedOnly, true);
  shown = { filtered: [all[2]], filtering: true };
  view.renderControls();
  assert.equal(element("#cleanup-button").disabled, true);
  fixture.workspace.dispose();
});
