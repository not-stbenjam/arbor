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
    "Folder missing · &lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt; · &lt;repo&gt;&amp;&quot;";
  assert.ok(markup.includes(`title="${escapedContext} · Unknown · —"`));
  assert.ok(
    markup.includes(
      '<span class="worktree-state" data-tone="muted" title="Folder gone; removes only its registration.">Folder missing</span><span> · </span><span class="worktree-branch">&lt;script&gt;',
    ),
  );
  // The row leads with the worktree's name. Its folder rows carry the rest
  // of the path, which stays available as a tooltip and in every action.
  assert.doesNotMatch(markup, /path-parent|&lt;parent&gt;/);
  assert.ok(markup.includes('id="worktree-row-id&quot;unsafe"'));
  assert.doesNotMatch(markup, /<script>|data-id="id"unsafe/);
  assert.match(markup, /Folder missing/);
  assert.match(markup, /class="size-cell">—</);
  assert.match(markup, /aria-selected="true"/);
  assert.match(markup, /data-delete="id&amp;|data-delete="id&quot;unsafe"/);
  assert.match(markup, /disabled>Delete/);
  for (const expected of [
    'data-path="/work/&lt;topic&gt;"',
    'title="/work/&lt;topic&gt;"',
    '<span class="path-leaf"><span class="path-basename">&lt;topic&gt;</span></span>',
    'data-id="id&quot;unsafe"',
    'data-worktree-menu="id&quot;unsafe"',
    'aria-label="Actions for &lt;topic&gt;"',
    'aria-label="Delete &lt;topic&gt;"',
    '<span class="worktree-branch">&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;</span><span> · </span><span class="worktree-repository">&lt;repo&gt;&amp;&quot;</span>',
    // A row's buttons are for the pointer: Delete and Enter reach the same
    // actions from the row, so Tab does not stop twice at every worktree.
    '<button class="row-action" tabindex="-1" data-delete=',
    '<button class="icon-button row-menu" tabindex="-1" data-worktree-menu=',
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
    // Green marks exactly what Delete recommended removes. A merged commit that
    // is not offered for one-click cleanup must not look as if it were.
    [{ ...removable, merged: true, recommended: false }, null],
    // Ancestry alone is not finished work in a checkout created moments ago.
    [{ ...removable, merged: true, fresh: true }, "muted", "New"],
    [{ ...discardable, locked: true, merged: true }, "muted", "Locked"],
    [{ ...discardable, ignored: true, merged: true }, "caution", "Ignored files"],
    [
      { ...discardable, dirty: true, changedFiles: 1, ignored: true },
      "caution",
      "1 changed file",
    ],
    [
      { ...discardable, dirty: true, changedFiles: 12 },
      "caution",
      "12 changed files",
    ],
    [{ ...discardable, dirty: true }, "caution", "Uncommitted changes"],
    [{ ...discardable, empty: true }, "muted", "Empty folder"],
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
      '<span class="worktree-state" data-tone="muted" title="&lt;held&gt; &amp; &quot;kept&quot;">Locked</span><span> · </span><span class="worktree-branch">topic</span><span> · </span><span class="worktree-repository">repo</span>',
    ),
  );
  assert.ok(markup.includes('title="Locked · topic · repo · Unknown · —"'));
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

test("selection reconciles provisional IDs by path and drops what has gone", async () => {
  const { reconcileSelection } = await import("../renderer/selection.mjs");
  const previous = [
    { id: "pending", path: "/one", pending: true },
    { id: "gone", path: "/two" },
  ];
  const next = [{ id: "registered", path: "/one" }];
  const before = {
    ids: new Set(["pending", "gone"]),
    cursor: "pending",
  };
  const actual = reconcileSelection(previous, next, before);
  assert.deepEqual([...actual.ids], ["registered"]);
  assert.equal(actual.cursor, "registered");
  assert.deepEqual(
    [...before.ids],
    ["pending", "gone"],
    "reconciliation is pure",
  );
  assert.deepEqual(reconcileSelection(previous, next, before, false), {
    ids: new Set(),
    cursor: "",
  });
});

test("going to a row never unticks another; a tick flips one row and a range adds from the cursor, in visible tree order", async () => {
  const { selectRow } = await import("../renderer/selection.mjs");
  const rows = ["a", "c", "b", "d", "e"].map((id) => ({ id }));
  const ids = (value) => [...value.ids].sort().join("");
  // An arrow key or a right-click moves the cursor and ticks nothing.
  let value = selectRow({ ids: new Set(), cursor: "" }, rows, "a");
  assert.equal(ids(value), "");
  assert.equal(value.cursor, "a");
  // A range ticks from the cursor to here, in the order the rows are shown.
  value = selectRow(value, rows, "b", { range: true });
  assert.equal(ids(value), "abc");
  assert.equal(value.cursor, "b");
  // A tick, which is a click on the row or its box, flips that one row and
  // leaves the rest.
  value = selectRow(value, rows, "c", { tick: true });
  assert.equal(ids(value), "ab");
  // Going somewhere else afterwards keeps every tick.
  value = selectRow(value, rows, "a");
  assert.equal(ids(value), "ab");
  assert.equal(value.cursor, "a");
  value = selectRow(value, rows, "c", { tick: true });
  assert.equal(ids(value), "abc");
  // A range adds to what is ticked, in either direction, and a Shift-click,
  // which is both a tick and a range, is the range: it never unticks.
  const backward = selectRow({ ids: new Set(["b"]), cursor: "b" }, rows, "a", {
    tick: true,
    range: true,
  });
  assert.equal(ids(backward), "abc");
  const same = selectRow({ ids: new Set(["b"]), cursor: "b" }, rows, "b", {
    tick: true,
    range: true,
  });
  assert.equal(ids(same), "b");
  // The range starts where the cursor is, wherever a row was last ticked:
  // tick a, walk down to b, and Shift-click e takes b to e, not a to e.
  let walked = selectRow({ ids: new Set(), cursor: "" }, rows, "a", {
    tick: true,
  });
  walked = selectRow(walked, rows, "c");
  walked = selectRow(walked, rows, "b");
  walked = selectRow(walked, rows, "e", { tick: true, range: true });
  assert.equal(ids(walked), "abde");
  // One range carries on from another: down two, then back up past the
  // start, has ticked everything it crossed.
  let run = selectRow({ ids: new Set(), cursor: "b" }, rows, "d", { range: true });
  run = selectRow(run, rows, "e", { range: true });
  run = selectRow(run, rows, "c", { range: true });
  assert.equal(ids(run), "bcde");
  // With no row to start from, or one no longer shown, a Shift-click is a
  // tick and a Shift-arrow only moves.
  for (const cursor of ["", "hidden"]) {
    const first = selectRow({ ids: new Set(), cursor }, rows, "c", {
      tick: true,
      range: true,
    });
    assert.equal(ids(first), "c");
    const moved = selectRow({ ids: new Set(), cursor }, rows, "c", {
      range: true,
    });
    assert.equal(ids(moved), "");
    assert.equal(moved.cursor, "c");
  }
});

test("selection preserves exact registration IDs and never expands duplicate paths", async () => {
  const { reconcileSelection } = await import("../renderer/selection.mjs");
  const rows = [
    { id: "repo-a", path: "/shared" },
    { id: "repo-b", path: "/shared" },
  ];
  const selection = {
    ids: new Set(["repo-b"]),
    cursor: "repo-b",
  };
  const kept = reconcileSelection(rows, [...rows].reverse(), selection);
  assert.deepEqual([...kept.ids], ["repo-b"]);
  assert.equal(kept.cursor, "repo-b");
  const removed = reconcileSelection(rows, [rows[0]], selection);
  assert.deepEqual([...removed.ids], []);
  assert.equal(removed.cursor, "");
  const provisional = [{ id: "pending", path: "/shared", pending: true }];
  const ambiguous = reconcileSelection(provisional, rows, {
    ids: new Set(["pending"]),
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
  const content = {
      innerHTML: "",
      listeners: {},
      addEventListener(name, fn) {
        this.listeners[name] = fn;
      },
    },
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
  // The command line's lower-case messages read as sentences, while a host's
  // name at the start of a line keeps the spelling its owner gave it.
  fixture.workspace.showError(
    "folder does not exist: /srv/code\nbuild-vps: Could not connect to build-vps over SSH\nées introuvables\nmyhost: folder does not exist",
  );
  view.render();
  assert.equal(
    element("#error-message").textContent,
    "Folder does not exist: /srv/code\nbuild-vps: Could not connect to build-vps over SSH\nÉes introuvables\nmyhost: folder does not exist",
  );
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
  assert.equal(
    element("#progress-heading").hidden,
    true,
    "one scanning host has its own Stop and needs no shared heading",
  );
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
        classes: new Set(),
        classList: {
          toggle(name, on) {
            const classes = elements.get(selector).classes;
            if (on) classes.add(name);
            else classes.delete(name);
          },
        },
        listeners: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        removeAttribute(name) {
          delete this.attributes[name];
        },
        selectedOptions: [{ textContent: "System" }],
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        },
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
    "Scanning build-vps:/sessions. Change in Settings…",
  );
  for (const selector of ["#window-context", "#version"])
    assert.equal(
      visited.has(selector),
      false,
      `preferences must not own ${selector}`,
    );
  visited.clear();
  chrome.render();
  assert.equal(
    element("#window-context").textContent,
    "build-vps — Arbor (Alpha)",
  );
  assert.equal(
    document.title,
    "build-vps — Arbor (Alpha)",
    "the system title bar names the same host as the in-window one",
  );
  assert.equal(element("#version").textContent, "Arbor test-version");
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
  // Appearance is not a scan setting. It applies and saves when chosen,
  // without waiting for, or causing, a scan.
  element("#theme-select").value = "dark";
  await element("#theme-select").onchange();
  assert.equal(preferences.theme, "dark");
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.deepEqual(
    writes.map((value) => value.theme),
    ["dark"],
  );
  assert.deepEqual(commands, [], "choosing a theme starts no scan");
  element("#scan-root").value = "/new";
  element("#scan-excludes").value = "**/build";
  await element("#settings-form").onsubmit({ preventDefault() {} });
  assert.equal(writes.length, 1, "submitting persists nothing itself");
  assert.deepEqual(commands, [
    {
      root: "/new",
      host: "_build",
      github: false,
      fetch: false,
      excludes: ["**/build"],
      safeIgnored: [],
    },
  ]);
  assert.equal(
    "theme" in commands[0],
    false,
    "a scan that waits its turn must not save an appearance chosen before it",
  );
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
    ["Deleted 3 worktrees · About 3 KB recovered.", false, undefined],
  ]);
  assert.match(fixture.workspace.error, /\/work\/kept: locked/);
  fixture.notifications.length = 0;
  fixture.api.remove = async () => ({
    results: [{ path: "/work/gone", removed: true }],
  });
  await fixture.workspace.deleteWorktrees([rows[2]]);
  // A missing folder was never deleted; only its registration was removed.
  assert.deepEqual(fixture.notifications, [
    ["Removed 1 missing worktree registration · No folder was there to delete.", false, undefined],
  ]);
  // A folder that vanished after the scan was not deleted either, and the
  // deletion itself says so: the size the scan measured is not claimed.
  fixture.notifications.length = 0;
  fixture.api.remove = async () => ({
    results: [
      { path: "/work/a", removed: true, missing: true },
      { path: "/work/b", removed: true, retainedBranch: "arbor/retained/b-1a2b3c" },
    ],
  });
  await fixture.workspace.deleteWorktrees(rows.slice(0, 2));
  assert.deepEqual(fixture.notifications, [
    [
      "Deleted 2 worktrees · About 1 KB recovered · Its commits are kept on the branch arbor/retained/b-1a2b3c.", false, undefined,
    ],
  ]);
  // Stopped part-way, what was not reached is said, and is not an error.
  fixture.notifications.length = 0;
  fixture.api.remove = async () => ({
    stopped: true,
    results: [{ path: "/work/a", removed: true }],
  });
  await fixture.workspace.deleteWorktrees([rows[0], rows[1], rows[3]]);
  assert.deepEqual(fixture.notifications, [
    ["Deleted 1 worktree · About 2 KB recovered · Stopped with 2 left alone.", false, undefined],
  ]);
  fixture.notifications.length = 0;
  fixture.api.remove = async () => ({ stopped: true, results: [] });
  await fixture.workspace.deleteWorktrees([rows[0], rows[1]]);
  assert.deepEqual(fixture.notifications, [["Stopped. 2 worktrees left alone."]]);
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

test("Delete recommended counts and describes exactly what the list shows, and asks before deleting", async () => {
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
  let shown = { filtered: all, filtering: false, selectedCount: 0 };
  let reviews = 0;
  const view = createWorkspaceView({
    document,
    workspace: fixture.workspace,
    shown: () => shown,
    onCleanup: () => reviews++,
  });
  const button = element("#cleanup-button");
  // The button lays out both labels and shows one.
  const label = () =>
    button.innerHTML.match(/data-current="true"><svg.*?<\/svg><span>([^<]*)</s)[1];
  view.render();
  // The ellipsis says it asks first.
  assert.equal(label(), "Delete recommended (2)…");
  assert.match(button.title, /Delete the 2 worktrees recommended on this computer, about 3 KB/);
  assert.match(button.title, /Shows each one, and why it is recommended, before deleting anything\.$/);
  // A search or repository filter narrows the action along with the list.
  shown = { ...shown, filtered: [all[1], all[2]], filtering: true };
  view.renderControls();
  assert.equal(label(), "Delete recommended (1)…");
  assert.match(
    button.title,
    /Delete the 1 worktree recommended shown in this view, about 2 KB/,
  );
  // The button sits beside Refresh. It deletes nothing: it opens the review
  // of what would be deleted, and the status bar goes on counting the list.
  await button.onclick({ detail: 1 });
  assert.equal(reviews, 1);
  assert.deepEqual(removed, []);
  assert.match(element("#status-message").textContent, /^3 worktrees · /);
  // A held Enter repeats the press; the repeats must not open it again.
  const key = (event) => {
    let prevented = false;
    button.listeners.keydown({
      ...event,
      preventDefault: () => (prevented = true),
    });
    return prevented;
  };
  assert.equal(key({ key: "Enter", repeat: true }), true);
  assert.equal(key({ key: "Enter", repeat: false }), false);
  // With nothing recommended in what is shown, there is nothing to review.
  shown = { filtered: [all[2]], filtering: true };
  view.renderControls();
  assert.equal(button.disabled, true);
  assert.equal(label(), "Delete recommended…");
  fixture.workspace.dispose();
});

test("deleting several worktrees chosen by hand shows every one, and what deleting it means, first", async () => {
  const { createCleanupController, deletionMeaning } = await import(
    "../renderer/cleanup-controller.mjs"
  );
  const row = (id, facts = {}) => ({
    id,
    path: `/local/trees/${id}`,
    head: id,
    branch: `topic/${id}`,
    repo: "api",
    canRemove: true,
    canDiscard: true,
    sizeBytes: 1024,
    defaultRef: "refs/remotes/origin/main",
    ...facts,
  });
  const rows = [
    row("merged", { recommended: true, mergeReason: "All commits are in refs/remotes/origin/main" }),
    row("unmerged"),
    row("new", { fresh: true }),
    row("dirty", { canRemove: false, losses: ["changes", "ignored"], blockers: ["Uncommitted or untracked files"] }),
    row("locked", { canRemove: false, locked: true, losses: [], blockers: ["Locked worktree"], discardWarnings: ["The Git worktree lock will be overridden."] }),
    row("broken", { canRemove: false, canDiscard: false, blockers: ["Worktree path could not be verified"] }),
  ];
  assert.deepEqual(rows.map(deletionMeaning), [
    { tone: "safe", text: "All commits are in origin/main" },
    { tone: "safe", text: "Not merged; branch kept" },
    { tone: "safe", text: "New; branch kept" },
    { tone: "risk", text: "Uncommitted changes and ignored files", grave: [], notes: [] },
    { tone: "note", text: "Lock overridden" },
    { tone: "kept", text: "Cannot be deleted: Worktree path could not be verified" },
  ]);
  const deleted = [];
  const fixture = await workspaceFixture({
    getState: async () =>
      coordinatorState({ report: { worktrees: rows, warnings: [] } }),
  });
  fixture.workspace.deleteWorktrees = (list, options) =>
    deleted.push([list.map((entry) => entry.id), options]);
  const { document, element } = preferenceDocument();
  const dialog = element("#cleanup-dialog"),
    list = element("#cleanup-list");
  list.querySelectorAll = () => [];
  // Only two of the six are in the list just now: the rest were ticked
  // under an earlier search.
  const review = createCleanupController({
    document,
    workspace: fixture.workspace,
    shown: () => ({ filtered: rows.slice(0, 2), visible: rows.slice(0, 2), filtering: true }),
  });
  review.openFor(rows);
  assert.equal(dialog.open, true);
  assert.equal(element("#cleanup-title").textContent, "Delete 5 of these 6 worktrees?");
  // Every one is listed, in or out of view, deletable or not.
  assert.equal([...list.innerHTML.matchAll(/data-review="/g)].length, 6);
  assert.deepEqual(
    [...list.innerHTML.matchAll(/data-tone="(\w+)"/g)].map(([, tone]) => tone),
    ["safe", "safe", "safe", "risk", "note", "kept"],
  );
  assert.match(list.innerHTML, /class="cleanup-item refused" data-review="broken"/);
  const lead = element("#cleanup-lead").innerHTML;
  assert.equal(lead, "<p>Branches and commits are kept; what each would lose is listed.</p>");
  assert.equal(
    element("#cleanup-total").textContent,
    "About 5 KB to recover · 3 not shown in the list",
  );
  // The button says more will be asked, because something would be discarded.
  assert.equal(element("#cleanup-confirm").textContent, "Delete 5 worktrees…");
  await element("#cleanup-confirm").onclick();
  assert.equal(dialog.open, false);
  assert.deepEqual(deleted, [
    [["merged", "unmerged", "new", "dirty", "locked"], { reviewed: true }],
  ]);
  // Where history is among what would be lost, the review does not also say
  // that commits are kept, and names that loss. A worktree's own refs are
  // one such: they go with it, whatever else is in it.
  const refs = row("refs", { canRemove: false, losses: ["changes", "refs"], blockers: ["Uncommitted or untracked files"] });
  assert.deepEqual(deletionMeaning(refs), {
    tone: "risk",
    text: "Uncommitted changes", grave: ["Permanently loses worktree refs (refs/worktree) and commits only they hold"], notes: [],
  });
  // Found only after the review opened, it is a different worktree to agree to.
  assert.notDeepEqual(deletionMeaning(refs), deletionMeaning({ ...refs, losses: ["changes"] }));
  review.openFor([rows[0], refs]);
  assert.match(
    element("#cleanup-lead").innerHTML,
    /Parent repository branches are kept; permanent losses are listed below\./,
  );
  assert.doesNotMatch(element("#cleanup-lead").innerHTML, /Their branches and commits are kept/);
  dialog.close();
  // With nothing to discard, agreeing is the whole of it.
  review.openFor(rows.slice(0, 3));
  assert.equal(element("#cleanup-title").textContent, "Delete these 3 worktrees?");
  assert.equal(element("#cleanup-confirm").textContent, "Delete 3 worktrees");
  assert.match(element("#cleanup-lead").innerHTML, /Branches and commits are kept\./);
  dialog.close();
  // The review of recommendations still says what it always did.
  const recommended = createCleanupController({
    document,
    workspace: fixture.workspace,
    shown: () => ({ filtered: rows, visible: rows, filtering: false }),
  });
  recommended.open();
  assert.equal(element("#cleanup-title").textContent, "Delete this recommended worktree?");
  assert.match(element("#cleanup-lead").innerHTML, /Branches and commits are kept\./);
  fixture.workspace.dispose();
});

test("the review lists what Delete recommended would delete and why, and deletes only what it showed", async () => {
  const { createCleanupController } = await import(
    "../renderer/cleanup-controller.mjs"
  );
  const row = (id, facts = {}) => ({
    id,
    path: `/local/trees/${id}`,
    head: id,
    branch: `topic/${id}`,
    repo: "api",
    canRemove: true,
    recommended: true,
    sizeBytes: 1024,
    mergeReason: "All commits are in refs/remotes/origin/main",
    ...facts,
  });
  const all = [
    row("a"),
    row("b", {
      sizeBytes: 2048,
      mergeReason: "GitHub PR #7 merged this exact commit into main",
    }),
    row("c", { recommended: false, mergeReason: "" }),
  ];
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
  // The list is drawn once; afterwards its items are only marked.
  const dialog = element("#cleanup-dialog"),
    list = element("#cleanup-list");
  let marks = {};
  list.querySelectorAll = () =>
    [...list.innerHTML.matchAll(/data-review="([^"]*)"/g)].map(([, id]) => {
      marks[id] ||= new Set();
      return {
        dataset: { review: id },
        classList: {
          toggle: (name, on) =>
            on ? marks[id].add(name) : marks[id].delete(name),
        },
      };
    });
  let handed = 0;
  const review = createCleanupController({
    document,
    workspace: fixture.workspace,
    shown: () => shown,
    onDeleting: () => handed++,
  });
  const text = (selector) => element(selector).textContent;
  // What a row says in one of its places, as text. A path is drawn folder
  // by folder so that it breaks between them.
  const cells = (name) =>
    [
      ...list.innerHTML.matchAll(
        new RegExp(
          `class="cleanup-${name}">(.*?)</${name === "path" ? "bdi></span" : "span"}>`,
          "g",
        ),
      ),
    ].map(([, value]) => value.replace(/<[^>]+>/g, ""));
  const changed = () =>
    Object.keys(marks).filter((id) => marks[id].has("changed"));

  // Nothing is drawn, and nothing asked, until it is opened.
  review.render();
  assert.equal(dialog.open, false);
  review.open();
  assert.equal(dialog.open, true);
  assert.deepEqual(removed, [], "opening the review deletes nothing");
  // What: exactly the recommendations shown, by name, with what each is,
  // where it is and how big.
  assert.deepEqual(cells("name"), ["a", "b"]);
  assert.deepEqual(cells("context"), ["topic/a · api", "topic/b · api"]);
  assert.deepEqual(cells("path"), ["/local/trees/a", "/local/trees/b"]);
  assert.match(
    list.innerHTML,
    /class="cleanup-path"><bdi><span class="path-part">\/<\/span><span class="path-part">local\/<\/span><span class="path-part">trees\/<\/span><span class="path-part">a<\/span><\/bdi>/,
  );
  assert.deepEqual(cells("size"), ["1 KB", "2 KB"]);
  // Why: each one's own evidence, with Git's ref names in plain form.
  assert.deepEqual(cells("reason"), [
    "All commits are in origin/main",
    "GitHub PR #7 merged this exact commit into main",
  ]);
  assert.equal(text("#cleanup-title"), "Delete these 2 recommended worktrees?");
  assert.equal(text("#cleanup-total"), "About 3 KB to recover · This computer");
  assert.equal(text("#cleanup-confirm"), "Delete 2 worktrees");
  assert.equal(element("#cleanup-confirm").disabled, false);
  assert.deepEqual(changed(), []);
  assert.equal(text("#cleanup-status"), "");

  // Cancel closes it and deletes nothing.
  element("#cleanup-cancel").onclick();
  assert.equal(dialog.open, false);
  assert.deepEqual(removed, []);

  // The list that was read is the list that is agreed to. A worktree whose
  // commit moves while it is open is marked and kept, and one that becomes a
  // recommendation meanwhile is not added.
  review.open();
  const drawn = list.innerHTML;
  shown = {
    ...shown,
    filtered: [{ ...all[0], head: "moved" }, all[1], row("late")],
  };
  review.render();
  assert.equal(list.innerHTML, drawn, "nothing is redrawn under the pointer");
  assert.deepEqual(changed(), ["a"]);
  assert.equal(
    text("#cleanup-title"),
    "Delete 1 of these 2 recommended worktrees?",
  );
  assert.equal(text("#cleanup-confirm"), "Delete 1 worktree");
  assert.equal(text("#cleanup-total"), "About 2 KB to recover · This computer");
  // Whoever is on Cancel cannot see the row being marked, so it is said.
  assert.equal(
    text("#cleanup-status"),
    "1 worktree changed and is kept. 1 worktree would be deleted.",
  );
  // Kept is kept: changing back does not put it in line to be deleted again.
  shown = { ...shown, filtered: [all[0], all[1]] };
  review.render();
  assert.deepEqual(changed(), ["a"]);
  assert.equal(text("#cleanup-confirm"), "Delete 1 worktree");
  await element("#cleanup-confirm").onclick();
  assert.equal(dialog.open, false);
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].items, [{ id: "b", head: "b" }]);
  assert.equal(removed[0].recommendedOnly, true);
  // Closing gives the keyboard back to a button that deleting disables.
  assert.equal(handed, 1);

  // Anything the review says about a worktree is part of what was agreed to.
  // The same folder at the same commit on another branch, or merged for
  // another reason, is kept in the same way, and so is one that is no longer
  // a recommendation. When none is left there is nothing to agree to.
  const kinds = [
    { branch: "topic/renamed" },
    { mergeReason: "All commits are in refs/remotes/upstream/main" },
    { repo: "other" },
    { recommended: false },
  ];
  for (const change of kinds) {
    shown = { filtered: all, filtering: false };
    marks = {};
    review.open();
    assert.equal(text("#cleanup-status"), "", "a new review starts unsaid");
    shown = { ...shown, filtered: [all[0], { ...all[1], ...change }] };
    review.render();
    assert.deepEqual(changed(), ["b"], JSON.stringify(change));
    assert.equal(text("#cleanup-confirm"), "Delete 1 worktree");
    element("#cleanup-cancel").onclick();
  }
  // A size measured again is not a change.
  shown = { filtered: all, filtering: false };
  review.open();
  marks = {};
  shown = { ...shown, filtered: [{ ...all[0], sizeBytes: 4096 }, all[1]] };
  review.render();
  assert.deepEqual(changed(), []);
  assert.equal(text("#cleanup-total"), "About 6 KB to recover · This computer");
  shown = { ...shown, filtered: [] };
  review.render();
  assert.deepEqual(changed().sort(), ["a", "b"]);
  assert.equal(text("#cleanup-title"), "These worktrees have changed");
  assert.match(text("#cleanup-total"), /^Close this list and open it again/);
  assert.equal(text("#cleanup-confirm"), "Delete");
  assert.equal(element("#cleanup-confirm").disabled, true);
  assert.equal(
    text("#cleanup-status"),
    "2 worktrees changed and are kept. Nothing would be deleted.",
  );
  await element("#cleanup-confirm").onclick();
  assert.equal(removed.length, 1, "a disabled answer deletes nothing");
  assert.equal(handed, 1);
  element("#cleanup-cancel").onclick();

  // A filter narrows the review as it narrows the list, and says so. One
  // worktree is asked about as one.
  shown = { filtered: [all[1], all[2]], filtering: true };
  review.open();
  assert.deepEqual(cells("name"), ["b"]);
  assert.equal(text("#cleanup-title"), "Delete this recommended worktree?");
  assert.equal(
    text("#cleanup-total"),
    "About 2 KB to recover · Only what the list is showing",
  );
  // Opening it again while it is open changes nothing.
  shown = { filtered: all, filtering: false };
  review.open();
  assert.deepEqual(cells("name"), ["b"]);
  shown = { filtered: [all[2]], filtering: true };
  review.render();
  assert.equal(text("#cleanup-title"), "This worktree has changed");
  element("#cleanup-cancel").onclick();
  // With nothing recommended there is nothing to open.
  shown = { filtered: [all[2]], filtering: false };
  review.open();
  assert.equal(dialog.open, false);

  // A held Enter repeats the press that opened the review; the repeats do
  // not go on to answer it.
  const key = (event) => {
    let prevented = false;
    dialog.listeners.keydown({
      ...event,
      preventDefault: () => (prevented = true),
    });
    return prevented;
  };
  assert.equal(key({ key: "Enter", repeat: true }), true);
  assert.equal(key({ key: "Enter", repeat: false }), false);
  assert.equal(key({ key: " ", repeat: true }), false);
  fixture.workspace.dispose();
});

test("the review waits for an operation that holds a worktree, and says every host and odd name plainly", async () => {
  const { createCleanupController } = await import(
    "../renderer/cleanup-controller.mjs"
  );
  const rows = [
    {
      id: JSON.stringify(["vps", "a"]),
      host: "vps",
      // A name that tries to hide or reorder what is read beside it.
      path: "/srv/trees/safe\u202Egpj.exe\u0007<b>",
      head: "a",
      branch: "topic/a",
      repo: "api",
      canRemove: true,
      recommended: true,
      sizeBytes: 1024,
    },
  ];
  const state = coordinatorState({
    hostFilter: null,
    report: { worktrees: rows, warnings: [] },
  });
  state.hosts = [{ ...state.hosts[0], host: "vps", label: "Build <VPS>" }];
  const removed = [];
  const fixture = await workspaceFixture({
    getState: async () => state,
    refreshHosts: async () => state,
    remove: async (selection) => {
      removed.push(selection);
      return { cancelled: true, results: [] };
    },
  });
  const { document, element } = preferenceDocument();
  // Whatever else makes the workspace unavailable, such as a lost connection.
  let unavailable = false;
  const review = createCleanupController({
    document,
    workspace: Object.create(fixture.workspace, {
      blocked: { get: () => unavailable || fixture.workspace.blocked },
    }),
    shown: () => ({ filtered: rows, filtering: false }),
  });
  const focused = [];
  element("#cleanup-cancel").focus = () => focused.push("cancel");
  element("#cleanup-title").focus = () => focused.push("title");
  review.open();
  // With room for its buttons, the review leaves the keyboard on Cancel.
  assert.deepEqual(focused, []);
  const markup = element("#cleanup-list").innerHTML;
  // Each name keeps its own direction, and what would hide or reorder it is
  // drawn as a mark.
  assert.match(
    markup,
    /class="cleanup-name"><bdi>safe\ufffdgpj\.exe\ufffd&lt;b&gt;<\/bdi></,
  );
  assert.match(
    markup,
    /<span class="path-part">trees\/<\/span><span class="path-part">safe\ufffdgpj\.exe\ufffd&lt;b&gt;<\/span><\/bdi>/,
  );
  assert.match(
    markup,
    /class="cleanup-context"><bdi>topic\/a<\/bdi> · <bdi>api<\/bdi> · <bdi>Build &lt;VPS&gt;<\/bdi></,
  );
  // With no evidence recorded, the reason is still said in words.
  assert.match(
    markup,
    /class="cleanup-reason"><bdi>All of its commits are in the default branch<\/bdi></,
  );
  assert.equal(
    element("#cleanup-total").textContent,
    "About 1 KB to recover · All hosts",
  );
  // Another operation holding the worktree's host changes nothing about the
  // worktree. Nothing is marked; deleting waits, and says that it does. The
  // keyboard, if it was on Delete, goes to the answer that is still there.
  const said = () => element("#cleanup-status").textContent;
  document.activeElement = element("#cleanup-confirm");
  state.hosts = [{ ...state.hosts[0], operation: "inspect" }];
  await fixture.workspace.refresh();
  review.render();
  assert.equal(element("#cleanup-confirm").disabled, true);
  assert.deepEqual(focused, ["cancel"]);
  document.activeElement = element("#cleanup-cancel");
  assert.equal(
    element("#cleanup-total").textContent,
    "Deleting is unavailable until the current operation finishes.",
  );
  assert.equal(said(), "Deleting is unavailable for now.");
  await element("#cleanup-confirm").onclick();
  assert.deepEqual(removed, []);
  state.hosts = [{ ...state.hosts[0], operation: null }];
  await fixture.workspace.refresh();
  review.render();
  assert.equal(element("#cleanup-confirm").disabled, false);
  assert.equal(element("#cleanup-confirm").textContent, "Delete 1 worktree");
  assert.equal(said(), "Deleting is available again.");
  assert.deepEqual(focused, ["cancel"], "the keyboard is not moved again");
  // A lost connection does not end by itself, and is not called an operation.
  unavailable = true;
  review.render();
  assert.equal(element("#cleanup-confirm").disabled, true);
  assert.equal(
    element("#cleanup-total").textContent,
    "Deleting is unavailable for now.",
  );
  assert.equal(said(), "Deleting is unavailable for now.");
  unavailable = false;
  review.render();
  assert.equal(said(), "Deleting is available again.");
  element("#cleanup-cancel").onclick();

  // With so little room that the buttons are below the list, the review
  // starts at its heading, and so does the keyboard. What the heading says
  // is this review's question by the time it is shown and focused, not what
  // the last review ended on.
  const dialog = element("#cleanup-dialog");
  element("#cleanup-title").textContent = "These worktrees have changed";
  const heard = [];
  const hear = () => heard.push(element("#cleanup-title").textContent);
  dialog.showModal = function () {
    this.open = true;
    hear();
  };
  element("#cleanup-title").focus = () => {
    focused.push("title");
    hear();
  };
  dialog.scrollHeight = 900;
  dialog.clientHeight = 200;
  dialog.scrollTop = 500;
  review.open();
  assert.equal(dialog.scrollTop, 0);
  assert.deepEqual(focused, ["cancel", "title"]);
  assert.deepEqual(heard, [
    "Delete this recommended worktree?",
    "Delete this recommended worktree?",
  ]);
  // A new review has had no waiting to speak of.
  assert.equal(said(), "");
  fixture.workspace.dispose();
});

test("a tick outlives a filter, the keyboard cursor does not, and nothing out of view is deleted unseen", async (t) => {
  const { createWorktreeView } = await import("../renderer/worktree-view.mjs");
  // The view quotes identities into selectors with the browser's CSS.escape.
  globalThis.CSS = { escape: String };
  t.after(() => delete globalThis.CSS);
  const row = (id) => ({
    id,
    path: `/local/team/${id}`,
    head: id,
    branch: id,
    repo: "repo",
    canRemove: true,
  });
  const deleted = [],
    reviewed = [],
    menus = [];
  const fixture = await workspaceFixture({
    getState: async () =>
      coordinatorState({
        report: { worktrees: [row("alpha"), row("beta")], warnings: [] },
      }),
  });
  fixture.workspace.deleteWorktrees = (rows) => deleted.push(rows);
  const { document, element } = preferenceDocument();
  document.getElementById = () => null;
  const listeners = {};
  for (const selector of ["#table-scroll", "#worktree-grid"])
    element(selector).addEventListener = (type, listener) => {
      listeners[`${selector} ${type}`] = listener;
    };
  const trees = createWorktreeView({
    document,
    workspace: fixture.workspace,
    tree: require("./worktree-tree.mjs"),
    showWorktreeMenu: (id) => menus.push(id),
    reviewDeletion: (rows) => reviewed.push(rows.map((entry) => entry.id)),
  });
  trees.render();
  const click = (id) =>
    listeners["#table-scroll click"]({
      target: {
        closest: (selector) =>
          selector === "[data-id]" ? { dataset: { id } } : null,
      },
    });
  const press = (key) =>
    listeners["#worktree-grid keydown"]({
      key,
      target: { closest: () => null },
      preventDefault() {},
    });
  click("alpha");
  assert.equal(trees.selectedCount, 1, "clicking a row ticks it");
  press("Enter");
  press("Delete");
  assert.deepEqual(menus, ["alpha"]);
  assert.deepEqual(
    deleted.map((rows) => rows.map((entry) => entry.id)),
    [["alpha"]],
  );
  // Filtering alpha away keeps its tick, and says it is not shown. Enter
  // has no row to act on. Delete still means what is ticked, but a row out
  // of view is never asked about by name alone: it goes to the review,
  // which lists it.
  element("#search").oninput({ target: { value: "beta" } });
  assert.deepEqual(
    trees.filtered.map((entry) => entry.id),
    ["beta"],
  );
  assert.equal(trees.selectedCount, 1, "the tick outlives the filter");
  assert.equal(
    element("#selection-label").textContent,
    "1 worktree selected · 1 not shown",
  );
  press("Enter");
  press("Delete");
  assert.deepEqual(menus, ["alpha"], "no menu for a hidden worktree");
  assert.equal(deleted.length, 1, "nothing out of view is deleted unseen");
  assert.deepEqual(reviewed, [["alpha"]]);
  // A second search adds to what the first gathered.
  click("beta");
  assert.equal(trees.selectedCount, 2);
  assert.equal(
    element("#selection-label").textContent,
    "2 worktrees selected · 1 not shown",
  );
  // Clearing the filter shows both again, and does not put the cursor back
  // on a row it had left.
  element("#search").oninput({ target: { value: "" } });
  assert.equal(element("#selection-label").textContent, "2 worktrees selected");
  press("Delete");
  assert.deepEqual(reviewed.at(-1), ["alpha", "beta"], "several are reviewed");
  // A collapsed folder takes its rows out of the list in the same way.
  listeners["#table-scroll click"]({
    target: {
      closest: (selector) =>
        selector === "button"
          ? {
              dataset: {
                toggleDirectory: JSON.stringify(["", "/local/team"]),
              },
            }
          : null,
    },
  });
  assert.equal(
    element("#selection-label").textContent,
    "2 worktrees selected · 2 not shown",
  );
  menus.length = 0;
  press("Enter");
  press("Delete");
  assert.deepEqual(menus, [], "no menu for a row in a closed folder");
  assert.equal(deleted.length, 1);
  assert.deepEqual(reviewed.at(-1), ["alpha", "beta"]);
  // Escape lets go of every tick, seen or not.
  press("Escape");
  assert.equal(trees.selectedCount, 0);
  fixture.workspace.dispose();
});

test("the keyboard stays somewhere useful when its row, or every row, goes away", async (t) => {
  const { createWorktreeView } = await import("../renderer/worktree-view.mjs");
  globalThis.CSS = { escape: String };
  t.after(() => delete globalThis.CSS);
  const row = (id) => ({
    id,
    path: `/local/team/${id}`,
    head: id,
    branch: id,
    repo: "repo",
    canRemove: true,
  });
  let rows = [row("alpha"), row("beta"), row("gamma")];
  const state = () =>
    coordinatorState({ report: { worktrees: rows, warnings: [] } });
  const fixture = await workspaceFixture({
    getState: async () => state(),
    refreshHosts: async () => state(),
  });
  const deleted = [],
    menus = [],
    focused = [];
  fixture.workspace.deleteWorktrees = (list) => deleted.push(list);
  const { document, element } = preferenceDocument();
  document.getElementById = () => null;
  const listeners = {};
  for (const selector of ["#table-scroll", "#worktree-grid", "#selection-bar"])
    element(selector).addEventListener = (type, listener) => {
      listeners[`${selector} ${type}`] = listener;
    };
  for (const selector of ["#worktree-grid", "#refresh-button"])
    element(selector).focus = () => focused.push(selector);
  // Focus is on the list itself, not on a control inside its rows.
  element("#worktree-list").contains = () => false;
  const trees = createWorktreeView({
    document,
    workspace: fixture.workspace,
    tree: require("./worktree-tree.mjs"),
    showWorktreeMenu: (id) => menus.push(id),
  });
  trees.render();
  const press = (key, onButton = false) =>
    listeners["#worktree-grid keydown"]({
      key,
      target: { closest: (selector) => (onButton && selector === "button" ? {} : null) },
      preventDefault() {},
    });
  const click = (id) =>
    listeners["#table-scroll click"]({
      target: {
        closest: (selector) =>
          selector === "[data-id]" ? { dataset: { id } } : null,
      },
    });
  // A click ticks the row and a second click unticks it; the cursor stays.
  click("beta");
  assert.equal(trees.selectedCount, 1);
  click("beta");
  document.activeElement = element("#worktree-grid");
  assert.equal(trees.selectedCount, 0);

  // Beta is deleted. The list still has the keyboard, so the cursor moves to
  // the row now in beta's place. It selects nothing: Enter has a row to act
  // on, and Delete still has nothing chosen.
  rows = [row("alpha"), row("gamma")];
  await fixture.workspace.refresh();
  trees.render();
  press("Enter");
  assert.deepEqual(menus, ["gamma"]);
  assert.equal(trees.selectedCount, 0);
  // With nothing ticked, Delete takes the row the cursor is on.
  press("Delete");
  assert.deepEqual(
    deleted.at(-1).map((entry) => entry.id),
    ["gamma"],
  );
  // Removing the last row of the list moves the cursor up, not off the end.
  rows = [row("alpha")];
  await fixture.workspace.refresh();
  trees.render();
  press("Enter");
  assert.deepEqual(menus, ["gamma", "alpha"]);

  // Escape clears the selection from one of a row's own buttons as well.
  press(" ");
  assert.equal(trees.selectedCount, 1, "Space ticks the row under the cursor");
  press("Escape", true);
  assert.equal(trees.selectedCount, 0);

  // With no row left to stay on, the keyboard goes to the next thing to do.
  focused.length = 0;
  rows = [];
  await fixture.workspace.refresh();
  trees.render();
  assert.deepEqual(focused, ["#refresh-button"]);
  assert.equal(element("#worktree-grid").tabIndex, -1);
  fixture.workspace.dispose();
});

test("an empty list says whether the scan failed, was stopped, or found nothing", async (t) => {
  const { createWorktreeView } = await import("../renderer/worktree-view.mjs");
  globalThis.CSS = { escape: String };
  t.after(() => delete globalThis.CSS);
  const emptyState = async (changes, prepare = () => {}) => {
    const fixture = await workspaceFixture({
      getState: async () => coordinatorState(changes),
    });
    prepare(fixture.workspace);
    const { document, element } = preferenceDocument();
    document.getElementById = () => null;
    createWorktreeView({
      document,
      workspace: fixture.workspace,
      tree: require("./worktree-tree.mjs"),
      showWorktreeMenu() {},
    }).render();
    fixture.workspace.dispose();
    return element("#empty-state").innerHTML;
  };
  assert.match(await emptyState({}), /No linked worktrees here/);
  // The reason is in the middle of the window as well as in the banner,
  // which can be dismissed.
  const failed = await emptyState({
    error: "folder does not exist: /srv/<gone>\nbuild-vps: unreachable",
  });
  assert.match(failed, /This scan did not finish/);
  assert.ok(
    failed.includes(
      "<p>Folder does not exist: /srv/&lt;gone&gt;<br />build-vps: unreachable</p>",
    ),
    failed,
  );
  assert.match(failed, /data-scan-again/);
  // The one failure with a way out says so, and offers it first.
  const gone = await emptyState({ error: "folder does not exist: /srv/<gone>" });
  assert.match(gone, /<h2>The folder to scan is not there<\/h2>/);
  assert.ok(gone.includes('<span class="empty-path">/srv/&lt;gone&gt;</span> does not exist on this computer'), gone);
  assert.ok(gone.indexOf("data-choose-folder") < gone.indexOf("data-scan-again"), gone);
  // A command that failed in this window found nothing either.
  assert.match(
    await emptyState({}, (workspace) => workspace.showError("Arbor is closing")),
    /This scan did not finish<\/h2><p>Arbor is closing<\/p>/,
  );
  const stopped = await emptyState({ cancelled: true });
  assert.match(stopped, /Scan stopped before it finished/);
  assert.match(stopped, /data-scan-again/);
  assert.doesNotMatch(stopped, /No linked worktrees here/);
});

test("scan progress redraws only when it changes, keeps the keyboard on Stop, and is announced by stage", async (t) => {
  const { createWorkspaceView } = await import(
    "../renderer/workspace-view.mjs"
  );
  globalThis.CSS = { escape: String };
  t.after(() => delete globalThis.CSS);
  let progress = { stage: "inspect", path: "/local/a", completed: 1, total: 3 };
  let busy = true;
  const state = () => {
    const next = coordinatorState({ busy, canCancelScan: busy, progress });
    return next;
  };
  const fixture = await workspaceFixture({
    getState: async () => state(),
    refreshHosts: async () => state(),
  });
  const { document, element } = preferenceDocument();
  const list = element("#host-progress-list");
  let writes = 0,
    markup = "";
  Object.defineProperty(list, "innerHTML", {
    get: () => markup,
    set(value) {
      writes++;
      markup = value;
    },
  });
  const focused = [];
  const stop = { disabled: false, focus: () => focused.push("stop") };
  list.querySelector = () => (busy ? stop : null);
  element("#refresh-button").focus = () => focused.push("refresh");
  const view = createWorkspaceView({ document, workspace: fixture.workspace });
  view.render();
  assert.equal(writes, 1);
  assert.equal(
    element("#announcement").textContent,
    "This computer: Checking worktrees…",
  );
  view.render();
  assert.equal(writes, 1, "an unchanged row is not rebuilt");
  // Stop all goes away when only one scan is left; the keyboard goes to the
  // Stop that remains.
  document.activeElement = element("#stop-scan");
  view.render();
  assert.deepEqual(focused.splice(0), ["stop"]);
  // The keyboard is on Stop when the count moves on.
  document.activeElement = { dataset: { stopHost: "" } };
  progress = { ...progress, path: "/local/b", completed: 2 };
  await fixture.workspace.refresh();
  view.render();
  assert.equal(writes, 2);
  assert.deepEqual(focused, ["stop"]);
  assert.equal(
    element("#announcement").textContent,
    "This computer: Checking worktrees…",
    "a new path within the same stage is not announced again",
  );
  // The scan ends, and with it the button that had the keyboard.
  busy = false;
  progress = null;
  await fixture.workspace.refresh();
  view.render();
  assert.deepEqual(focused, ["stop", "refresh"]);
  assert.equal(element("#announcement").textContent, "Finished.");
  fixture.workspace.dispose();
});

test("a chart's scale is round, labelled, and never below its tallest day", async () => {
  const { scaleTop, createStatisticsController } = await import(
    "../renderer/statistics-controller.mjs"
  );
  const GB = 1024 ** 3,
    MB = 1024 ** 2;
  // Counts: a whole number whose half is whole too.
  for (const [most, top] of [[1, 2], [2, 2], [3, 4], [12, 12], [13, 16], [17, 20], [55, 60], [214, 400], [900, 1000]])
    assert.equal(scaleTop(most, true), top, `count ${most}`);
  // Sizes: round in the unit they are shown in.
  for (const [most, top] of [[14.6 * GB, 16 * GB], [2.1 * GB, 3 * GB], [900 * MB, 1000 * MB], [1.2 * GB, 2 * GB], [300, 300], [1, 2]])
    assert.equal(scaleTop(most, false), top, `size ${most}`);
  for (const most of [1, 7, 99, 1023, 1025, 5e5, 3.3 * GB, 6e13]) {
    assert.ok(scaleTop(most, false) >= most);
    assert.ok(scaleTop(most, false) < most * 2.6, `not needlessly tall: ${most}`);
  }

  const today = new Date();
  const day = (ago) =>
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - ago))
      .toISOString()
      .slice(0, 10);
  const fixture = dialogFixture();
  await createStatisticsController({
    document: fixture.document,
    getHost: () => "",
    api: {
      getStats: async () => ({
        host: "",
        report: {
          ...statsReport(14),
          daily: [
            { date: day(3), removedWorktrees: 13, estimatedBytesReclaimed: 14.6 * GB },
            { date: day(0), removedWorktrees: 1, estimatedBytesReclaimed: 300 * MB },
          ],
        },
      }),
    },
  }).open();
  const markup = fixture.content.innerHTML;
  // The lines of each chart say what they stand for.
  assert.match(markup, /class="statistics-scale" aria-hidden="true"><span>16<\/span><span>8<\/span><span>0<\/span>/);
  assert.match(markup, /class="statistics-scale" aria-hidden="true"><span>16 GB<\/span><span>8 GB<\/span><span>0<\/span>/);
  // Bars are drawn against the scale: thirteen of sixteen is not full height.
  assert.match(markup, /<rect class="statistics-bar" x="262" y="19\.875" width="6" height="60\.125"/);

  assert.equal(scaleTop(Number.MAX_VALUE, true), 1e15, "no scale reaches the sky");
  for (const damaged of [NaN, Infinity, -5, 0]) assert.equal(scaleTop(damaged, false), 2);

  // The plot is one stop for the keyboard: a choice of day, starting at
  // today, which a screen reader is told as a sentence.
  assert.match(
    markup,
    /data-chart="removedWorktrees" data-day="29" tabindex="0" role="slider" aria-orientation="horizontal" aria-label="Day in the worktrees deleted chart: 14 in the last 30 days" aria-valuemin="1" aria-valuemax="30" aria-valuenow="30" aria-valuetext="Today: 1 worktree deleted"/,
  );
  const plot = (field) => {
    const attributes = {},
      marker = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } },
      readout = { textContent: "" };
    const self = {
      dataset: { chart: field, day: "29" },
      attributes,
      marker,
      readout,
      hasFocus: false,
      matches: (selector) => selector === ":focus" && self.hasFocus,
      contains: () => false,
      setAttribute: (name, value) => (attributes[name] = value),
      querySelector: (selector) => (selector === "svg" ? { getBoundingClientRect: () => ({ left: 100, width: 300 }) } : marker),
      parentElement: { querySelector: () => readout },
    };
    return self;
  };
  const send = (type, target, event = {}) => {
    let prevented = false;
    fixture.content.listeners[type]({
      ...event,
      target: { closest: () => target },
      preventDefault: () => (prevented = true),
    });
    return prevented;
  };
  const press = (target, key) => send("keydown", target, { key });
  const focus = (target, on) => {
    target.hasFocus = on;
    send(on ? "focusin" : "focusout", target);
  };
  const counts = plot("removedWorktrees");
  // With the keyboard on it, the plot shows the day it is on: today.
  focus(counts, true);
  assert.equal(counts.readout.textContent, "Today: 1");
  assert.equal(counts.marker.attributes.x, 290);
  assert.equal(counts.marker.attributes.visibility, "visible");
  // One step back is yesterday, not today again.
  assert.equal(press(counts, "ArrowLeft"), true);
  assert.match(counts.readout.textContent, /: 0$/);
  assert.equal(counts.attributes["aria-valuenow"], 29);
  assert.match(counts.attributes["aria-valuetext"], /: Nothing deleted$/);
  press(counts, "ArrowLeft");
  press(counts, "ArrowLeft");
  assert.match(counts.readout.textContent, /: 13$/);
  assert.match(counts.attributes["aria-valuetext"], /: 13 worktrees deleted$/);
  assert.equal(counts.dataset.day, 26);
  // Pointing at another day shows it without choosing it, and leaving, even
  // into the margin beside the drawing, shows the chosen day again.
  send("pointermove", counts, { clientX: 100 + 29.5 * 10 });
  assert.equal(counts.readout.textContent, "Today: 1");
  assert.equal(counts.attributes["aria-valuenow"], 27, "pointing chooses nothing");
  send("pointermove", counts, { clientX: 100 + 31 * 10 });
  assert.match(counts.readout.textContent, /: 13$/);
  send("pointermove", counts, { clientX: 100 + 29.5 * 10 });
  send("pointerout", counts, { relatedTarget: null });
  assert.match(counts.readout.textContent, /: 13$/);
  press(counts, "ArrowRight");
  assert.equal(counts.attributes["aria-valuenow"], 28, "the keyboard carries on from where it was");
  press(counts, "Home");
  assert.equal(counts.attributes["aria-valuenow"], 1);
  press(counts, "ArrowLeft");
  assert.equal(counts.attributes["aria-valuenow"], 1, "it stops at the first day");
  press(counts, "End");
  press(counts, "ArrowRight");
  assert.equal(counts.attributes["aria-valuenow"], 30, "and at today");
  assert.equal(press(counts, "a"), false, "other keys are left alone");
  assert.equal(press(null, "ArrowLeft"), false, "and so are keys outside a plot");
  // Without the keyboard the plot shows a day only while it is pointed at.
  focus(counts, false);
  assert.equal(counts.readout.textContent, "");
  assert.equal(counts.marker.attributes.visibility, "hidden");
  send("pointermove", counts, { clientX: 100 + 26.5 * 10 });
  assert.match(counts.readout.textContent, /: 13$/);
  send("pointerout", counts, { relatedTarget: null });
  assert.equal(counts.readout.textContent, "");
  const sizes = plot("estimatedBytesReclaimed");
  focus(sizes, true);
  assert.equal(sizes.readout.textContent, "Today: 300 MB");
  press(sizes, "ArrowLeft");
  assert.match(sizes.attributes["aria-valuetext"], /: Nothing recovered$/);
});

test("statistics with a host missing never claim there have been no cleanups", async () => {
  const { createStatisticsController } = await import(
    "../renderer/statistics-controller.mjs"
  );
  const render = async (report) => {
    const fixture = dialogFixture();
    await createStatisticsController({
      document: fixture.document,
      getHost: () => null,
      api: { getStats: async () => ({ host: null, report }) },
    }).open();
    return fixture.content.innerHTML;
  };
  assert.match(await render(statsReport(0)), /<h3>No cleanups yet<\/h3>/);
  // An unreachable host may have a history. Say only what is known.
  const partial = await render({
    ...statsReport(0),
    warning: "Partial totals. build: unreachable",
  });
  assert.match(partial, /Partial totals\. build: unreachable/);
  assert.match(
    partial,
    /<h3>No cleanups recorded on the hosts that answered<\/h3>/,
  );
  assert.doesNotMatch(partial, /No cleanups yet/);
});

test("a row names what only an explicit discard gets past, and colors it by what could be lost", async () => {
  const { worktreeState } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const discardable = { canRemove: false, canDiscard: true };
  // Files Git was told not to look at may hold changes nobody can see.
  assert.deepEqual(
    worktreeState({
      ...discardable,
      blockers: [
        "Unchecked files: Git was told not to look at some tracked files (assume-unchanged or skip-worktree)",
      ],
      losses: ["unchecked"],
    }),
    {
      tone: "caution",
      label: "Unchecked files",
      detail:
        "Discards changes to unchecked files.",
    },
  );
  // A protected branch loses nothing by being deleted; it is only named.
  const protectedBranch = worktreeState({
    ...discardable,
    blockers: ["Protected branch name"],
    losses: [],
  });
  assert.equal(protectedBranch.tone, "muted");
  assert.equal(protectedBranch.label, "Protected branch name");
  // A detached HEAD is already named where the branch would be.
  assert.equal(
    worktreeState({
      ...discardable,
      detached: true,
      blockers: ["Detached HEAD; create a branch to retain its commits"],
      losses: [],
    }),
    null,
  );
  // A sparse checkout with nothing else to say stays quiet, like any other.
  assert.equal(
    worktreeState({ canRemove: true, canDiscard: true, blockers: [] }),
    null,
  );
});

test("a click on a row or its box ticks it; boxes tick folders and everything shown; nothing else changes what is ticked", async (t) => {
  const { createWorktreeView } = await import("../renderer/worktree-view.mjs");
  globalThis.CSS = { escape: String };
  t.after(() => delete globalThis.CSS);
  const row = (id, folder) => ({
    id,
    path: `/local/${folder}/${id}`,
    head: id,
    branch: id,
    repo: "repo",
    canRemove: true,
  });
  const fixture = await workspaceFixture({
    getState: async () =>
      coordinatorState({
        report: {
          worktrees: [row("alpha", "one"), row("beta", "one"), row("gamma", "two")],
          warnings: [],
        },
      }),
  });
  const deleted = [];
  fixture.workspace.deleteWorktrees = (rows) =>
    deleted.push(rows.map((entry) => entry.id));
  const { document, element } = preferenceDocument();
  document.getElementById = () => null;
  const listeners = {};
  for (const selector of ["#table-scroll", "#worktree-grid", "#worktree-list"])
    element(selector).addEventListener = (type, listener) => {
      listeners[`${selector} ${type}`] = listener;
    };
  const trees = createWorktreeView({
    document,
    workspace: fixture.workspace,
    tree: require("./worktree-tree.mjs"),
    showWorktreeMenu() {},
  });
  trees.render();
  // A click lands on a box or on the cell around it; either ticks.
  const tick = (dataset, shiftKey = false) =>
    listeners["#table-scroll click"]({
      shiftKey,
      target: {
        closest: (selector) =>
          selector === ".check-cell, .check-column"
            ? { querySelector: () => ({ dataset }) }
            : null,
      },
    });
  // A click anywhere else on a row lands on the row itself.
  const click = (id, shiftKey = false) =>
    listeners["#table-scroll click"]({
      shiftKey,
      target: {
        closest: (selector) =>
          selector === "[data-id]" ? { dataset: { id } } : null,
      },
    });
  const key = (name, extra = {}) =>
    listeners["#worktree-grid keydown"]({
      key: name,
      ...extra,
      target: { closest: () => null },
      preventDefault() {},
    });
  // An arrow key scrolls its row into view; these rows are not on a screen.
  document.querySelector = ((find) => (selector) =>
    selector.startsWith(".worktree-row[data-id=") ? null : find(selector))(
    document.querySelector,
  );
  const folder = (name) => JSON.stringify(["", `/local/${name}`]);

  tick({ select: "alpha" });
  assert.equal(trees.selectedCount, 1);
  // One tick is enough to say what will happen and to offer it.
  assert.equal(element("#selection-bar").hidden, false);
  assert.equal(element("#selection-label").textContent, "1 worktree selected");
  // The heading's box covers rows that are not all ticked, so it stays empty
  // and shows no dash.
  assert.equal(element("#select-all").checked, false);
  assert.ok(!element("#select-all").indeterminate);
  // The whole row is its box. Clicking another row ticks that one too and
  // leaves the first alone; clicking it again unticks only it.
  click("gamma");
  assert.equal(element("#selection-label").textContent, "2 worktrees selected");
  click("gamma");
  assert.equal(element("#selection-label").textContent, "1 worktree selected");
  // Going to a row with the keyboard ticks nothing and unticks nothing.
  key("End");
  key("ArrowUp");
  assert.equal(trees.selectedCount, 1);
  tick({ select: "gamma" });
  assert.equal(element("#selection-label").textContent, "2 worktrees selected");
  // A folder's box ticks what is shown under it, and unticks it when all is.
  tick({ selectFolder: folder("one") });
  assert.equal(trees.selectedCount, 3);
  tick({ selectFolder: folder("one") });
  assert.equal(trees.selectedCount, 1);
  // A row's box unticks its own row only.
  tick({ select: "gamma" });
  assert.equal(trees.selectedCount, 0);
  assert.equal(element("#selection-bar").hidden, true);
  // Shift on a box ticks the range from the last box used, and Shift on a
  // row the range from the last row clicked.
  tick({ select: "alpha" });
  tick({ select: "gamma" }, true);
  assert.equal(trees.selectedCount, 3);
  tick({});
  click("gamma");
  click("alpha", true);
  assert.equal(trees.selectedCount, 3);
  tick({});
  assert.equal(trees.selectedCount, 0);
  // The box in the heading ticks everything shown, then nothing.
  tick({});
  assert.equal(trees.selectedCount, 3);
  assert.equal(element("#select-all").checked, true);
  tick({});
  assert.equal(trees.selectedCount, 0);
  tick({});
  assert.equal(trees.selectedCount, 3);
  // Delete takes what is ticked, whichever row the cursor happens to be on,
  // and from a box as well as from the list: the box in the heading is where
  // the keyboard is left after ticking everything.
  key("Home");
  key("ArrowDown");
  key("Delete");
  assert.deepEqual(deleted.at(-1), ["alpha", "beta", "gamma"]);
  const onBox = (key, extra = {}) => {
    let prevented = false;
    listeners["#worktree-grid keydown"]({
      key,
      ...extra,
      target: { closest: (selector) => (selector === "input" ? {} : null) },
      preventDefault: () => (prevented = true),
    });
    return prevented;
  };
  deleted.length = 0;
  onBox("Delete");
  assert.deepEqual(deleted, [["alpha", "beta", "gamma"]]);
  // Space on a box is the box's own; the list does not also act on it.
  assert.equal(onBox(" "), false);
  assert.equal(trees.selectedCount, 3);

  // A held Space is one press. Its repeats neither untick nor tick again.
  tick({});
  assert.equal(trees.selectedCount, 0);
  key("Home");
  key(" ");
  key(" ", { repeat: true });
  key(" ", { repeat: true });
  assert.equal(trees.selectedCount, 1);
  // Ctrl or Cmd with an arrow key moves the cursor and ticks nothing; Shift
  // with one ticks the range it crosses.
  key("ArrowDown", { ctrlKey: true });
  key("ArrowDown", { metaKey: true });
  assert.equal(trees.selectedCount, 1);
  key("ArrowUp", { shiftKey: true });
  assert.equal(trees.selectedCount, 3);

  // A range starts at the row the cursor is on, which is where the last
  // click or arrow key left it. A folder's box and the heading's leave no
  // other place for a later range to start from.
  const ticked = () => {
    key("Delete");
    return deleted.at(-1);
  };
  key("End");
  tick({});
  assert.equal(trees.selectedCount, 0);
  key("ArrowUp", { shiftKey: true });
  assert.deepEqual(ticked(), ["beta", "gamma"]);
  tick({});
  tick({});
  assert.equal(trees.selectedCount, 0);
  click("alpha");
  key("End");
  click("gamma", true);
  assert.deepEqual(ticked(), ["alpha", "gamma"]);

  // Dragging across a row's text selects the text, to copy. It is not a
  // click on the row and ticks nothing; a press that barely moves is.
  const press = (x, y, extra = {}) => {
    let prevented = false;
    listeners["#worktree-list mousedown"]({
      clientX: x,
      clientY: y,
      button: 0,
      target: {
        closest: (selector) => (selector === "[data-id]" ? {} : null),
      },
      preventDefault: () => (prevented = true),
      ...extra,
    });
    return prevented;
  };
  const release = (id, x, y) =>
    listeners["#table-scroll click"]({
      detail: 1,
      clientX: x,
      clientY: y,
      target: {
        closest: (selector) =>
          selector === "[data-id]" ? { dataset: { id } } : null,
      },
    });
  press(100, 50);
  release("beta", 160, 52);
  assert.deepEqual(ticked(), ["alpha", "gamma"]);
  press(100, 50);
  release("beta", 102, 51);
  assert.deepEqual(ticked(), ["alpha", "beta", "gamma"]);
  // An earlier press says nothing about a click made without a pointer.
  press(400, 400);
  click("beta");
  assert.deepEqual(ticked(), ["alpha", "gamma"]);

  // Shift with a press on a row would select the text between two clicks, so
  // the press is taken. One on the row's own buttons or box is left alone,
  // and so is one with another button or without Shift.
  const control = (selector) => ({
    target: {
      closest: (asked) =>
        asked === "[data-id]" || asked === selector ? {} : null,
    },
  });
  assert.equal(press(0, 0, { shiftKey: true }), true);
  assert.equal(press(0, 0), false);
  assert.equal(press(0, 0, { shiftKey: true, button: 2 }), false);
  assert.equal(
    press(0, 0, { shiftKey: true, ...control("button, input") }),
    false,
  );
  fixture.workspace.dispose();
});

test("a row and a selection say when deleting is not a clean delete, before the confirmation does", async (t) => {
  const { renderTreeRows } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const { createWorktreeView } = await import("../renderer/worktree-view.mjs");
  globalThis.CSS = { escape: String };
  t.after(() => delete globalThis.CSS);
  const row = (id, facts = {}) => ({
    id,
    path: `/local/team/${id}`,
    head: id,
    branch: id,
    repo: "repo",
    canRemove: true,
    canDiscard: true,
    losses: [],
    ...facts,
  });
  const rows = [
    row("clean"),
    row("vendored", {
      canRemove: false,
      losses: ["submodules"],
      blockers: ["Submodules: has submodule checkouts, which keep commits of their own"],
    }),
    row("edited", { canRemove: false, dirty: true, losses: ["changes"] }),
    // Its folder is gone, but what Git kept for its submodules is not.
    row("lost", { canRemove: false, missing: true, losses: ["submodules"] }),
  ];
  const markup = renderTreeRows(
    rows.map((worktree) => ({ kind: "worktree", depth: 0, label: worktree.id, worktree })),
    { selected: new Set(), collapsed: new Set(), disabled: false, canDelete: () => true },
  );
  const { worktreeState: worktreeStateOf } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  // A folder has no row for the keyboard to stand on, so its box is a tab
  // stop; a worktree's is reached with Space from its row.
  const folders = renderTreeRows(
    [
      {
        kind: "directory",
        depth: 0,
        label: "team",
        node: { path: "/local/team", key: "team", descendants: rows },
      },
    ],
    { selected: new Set(), collapsed: new Set(), disabled: false, canDelete: () => true },
  );
  assert.match(folders, /<input type="checkbox" class="row-check" data-select-folder="team"/);
  assert.match(markup, /<input type="checkbox" class="row-check" tabindex="-1" data-select="clean"/);
  // The Delete button of a clean row is just Delete.
  assert.match(markup, /data-delete="clean" aria-label="Delete clean" >Delete</);
  assert.match(
    markup,
    /data-delete="vendored" aria-label="Delete vendored" title="Discards submodules and their unpushed commits\."/,
  );
  // Its row names the reason in the colour used for something to lose.
  assert.match(markup, /<button type="button" class="worktree-state state-files" tabindex="-1" data-show-files="vendored" data-tone="caution" title="Show Files: Deleting this worktree discards submodules[^"]*">Submodules<\/button>/);
  // What Git kept for a missing worktree's submodules outranks its being
  // missing, and its Delete button says so too.
  const gone = row("gone", {
    canRemove: false,
    missing: true,
    losses: ["submodules"],
  });
  assert.equal(worktreeStateOf(gone).label, "Submodules");
  assert.match(
    renderTreeRows([{ kind: "worktree", depth: 0, label: "gone", worktree: gone }], {
      selected: new Set(),
      collapsed: new Set(),
      disabled: false,
      canDelete: () => true,
    }),
    /data-delete="gone" aria-label="Delete gone" title="Discards/,
  );
  assert.equal(
    worktreeStateOf(row("absent", { canRemove: false, missing: true })).label,
    "Folder missing",
  );
  // A repository that would be lost outranks files that would be.
  const { worktreeState } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  assert.equal(
    worktreeState(
      row("holder", {
        canRemove: false,
        dirty: true,
        changedFiles: 1,
        losses: ["changes", "nested"],
      }),
    ).label,
    "Nested repository",
  );

  const fixture = await workspaceFixture({
    getState: async () =>
      coordinatorState({ report: { worktrees: rows, warnings: [] } }),
  });
  const { document, element } = preferenceDocument();
  document.getElementById = () => null;
  const listeners = {};
  for (const selector of ["#table-scroll", "#worktree-grid"])
    element(selector).addEventListener = (type, listener) => {
      listeners[`${selector} ${type}`] = listener;
    };
  const trees = createWorktreeView({
    document,
    workspace: fixture.workspace,
    tree: require("./worktree-tree.mjs"),
    showWorktreeMenu() {},
  });
  trees.render();
  const tick = (dataset) =>
    listeners["#table-scroll click"]({
      target: {
        closest: (selector) =>
          selector === ".check-cell, .check-column"
            ? { querySelector: () => ({ dataset }) }
            : null,
      },
    });
  tick({ select: "clean" });
  assert.equal(element("#selection-label").textContent, "1 worktree selected");
  tick({});
  assert.equal(
    element("#selection-label").textContent,
    "4 worktrees selected · 3 would lose files",
  );
  fixture.workspace.dispose();
});

test("compact row metadata repeats the age and size, with a complete tooltip", async () => {
  const { renderTreeRows } = await import("../renderer/worktree-presentation.mjs");
  const { ago } = await import("../renderer/presentation.mjs");
  const activityAt = new Date(Date.now() - 3 * 86400000).toISOString();
  for (const extra of [{}, { missing: true }, { pending: true }]) {
    const markup = renderTreeRows([{
      kind: "worktree", depth: 0, label: "agent",
      worktree: { id: "a", path: "/work/agent", branch: "topic", repo: "shop", sizeBytes: 1024, canRemove: true, activityAt, ...extra },
    }], { selected: new Set(), collapsed: new Set() });
    const bytes = extra.missing || extra.pending ? "—" : "1 KB";
    assert.ok(markup.includes(`class="worktree-metrics"> · ${ago(activityAt)} · ${bytes}</span>`));
    assert.match(markup, new RegExp(`title="[^"]* · 3d ago · ${bytes}"`));
    assert.ok(markup.includes(`class="size-cell">${bytes}</td>`));
  }
});

test("worktree rows have one concise name and a separate full-path description", async () => {
  const { renderTreeRows } = await import("../renderer/worktree-presentation.mjs");
  const activityAt = new Date(Date.now() - 3 * 86400000).toISOString();
  const row = { id: "a", path: "/work/storefront/agent-7f3a", branch: "agent/cart-badge", repo: "storefront", activityAt, sizeBytes: 1288490189, canRemove: true, recommended: true };
  const render = (extra = {}, cancelled = false) => renderTreeRows([{
    kind: "worktree", depth: 2, label: "storefront/agent-7f3a", worktree: { ...row, ...extra },
  }], { selected: new Set(), collapsed: new Set(), cancelled });
  const markup = render();
  assert.match(markup, /aria-label="agent-7f3a, Merged, branch agent\/cart-badge in storefront, 3 days ago, 1.2 GB"/);
  assert.match(markup, /aria-description="\/work\/storefront\/agent-7f3a"/);
  for (const name of ["Select", "Delete", "Actions for"])
    assert.ok(markup.includes(`aria-label="${name} agent-7f3a"`));
  assert.doesNotMatch(markup, /aria-label="[^"]*\/work\//);
  assert.match(render({ pending: true }, true), /aria-label="agent-7f3a, Scan incomplete, branch agent\/cart-badge in storefront, 3 days ago, Size unknown"/);
  assert.match(render({ pending: true, branch: "", activityAt: "" }), /agent-7f3a, Checking…, repository storefront, Last active unknown, Size unknown/);
  assert.match(render({ missing: true }), /Folder missing, branch agent\/cart-badge in storefront, 3 days ago, No folder on disk/);
  assert.match(render({ branch: "", detached: true, recommended: false }), /Detached HEAD in storefront/);
  assert.match(render({ path: '/work/<odd>"', branch: '<topic>"' }), /aria-description="\/work\/&lt;odd&gt;&quot;"/);
});

test("characters that cannot be seen are shown as a mark, so two names never look the same", async () => {
  const { plain, shown } = await import("../renderer/presentation.mjs");
  for (const hidden of ["​", "⁠", "﻿", "­", "‮", "⁦", "\u0007"])
    assert.equal(plain(`same${hidden}`), "same�", JSON.stringify(hidden));
  assert.notEqual(plain("same"), plain("same​"));
  // The joiners that scripts and emoji are written with are left as they are.
  assert.equal(plain("‍‌"), "‍‌");
  assert.equal(shown("<b>​"), "&lt;b&gt;�");
});

test("ordinary review reasons stay short and grave losses stay on separate lines", async () => {
  const { deletionMeaning } = await import("../renderer/cleanup-controller.mjs");
  const { worktreeState } = await import("../renderer/worktree-presentation.mjs");
  for (const losses of [["changes"], ["ignored"], ["unchecked"], ["changes", "ignored"], ["changes", "ignored", "unchecked"]]) {
    const row = { canDiscard: true, losses };
    const meaning = deletionMeaning(row);
    assert.ok(meaning.text.split(/\s+/).length <= 6, meaning.text);
    assert.deepEqual(meaning.grave, []);
    assert.ok(worktreeState(row), "every ordinary loss has a visible state control");
  }
  assert.equal(worktreeState({ canDiscard: true, losses: ["unchecked"] }).detail, "Discards changes to unchecked files.");
  for (const loss of ["nested", "submodules", "operation", "refs"]) {
    const meaning = deletionMeaning({ canDiscard: true, losses: ["ignored", loss] });
    assert.equal(meaning.text, "Ignored files");
    assert.equal(meaning.grave.length, 1);
    assert.match(meaning.grave[0], /^Permanently loses /);
  }
});

test("Show Files returned by removal opens only after settling and uses the current scoped row", async () => {
  const { createWorkspaceController } = await import("../renderer/workspace-controller.mjs");
  const row = { id: "scoped", path: "/work/a", head: "a", canDiscard: true, host: "" };
  let current = row, called = 0, workspace;
  workspace = createWorkspaceController({
    api: {
      getState: async () => coordinatorState({ report: { worktrees: [current], warnings: [] } }),
      remove: async () => { current = { ...row, head: "b" }; return { cancelled: true, results: [], showFiles: row.id }; },
    },
    linked: (rows) => rows, notify() {}, onChange() {}, onSetup() {}, onHostChange() {}, onReset() {},
    onShowFiles(shown) { called++; assert.equal(workspace.blocked, false); assert.equal(shown.head, "b"); },
    timers: { setTimeout() { return 1; }, clearTimeout() {} },
  });
  await workspace.initialize();
  await workspace.deleteWorktrees([row]);
  assert.equal(called, 1);
  workspace.dispose();
});
