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
  const tree = require("./worktree-tree.js");
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
    { ...options, collapsedDirectories: new Set(["/work/team"]) },
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

test("tree markup escapes metadata and distinguishes missing/pending checkouts", async () => {
  const { renderTreeRows } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const row = {
    kind: "worktree",
    label: "<topic>",
    pathPrefix: "/work",
    depth: 1,
    worktree: {
      id: 'id"unsafe',
      path: "/work/<topic>",
      branch: '<script>alert("no")</script>',
      repo: "repo",
      sizeBytes: 0,
      missing: true,
    },
  };
  const options = {
    selected: new Set(['id"unsafe']),
    collapsed: new Set(),
    disabled: true,
    cancelled: false,
  };
  const markup = renderTreeRows([row], options);
  assert.doesNotMatch(markup, /<script>|data-id="id"unsafe/);
  assert.match(markup, /Missing checkout/);
  assert.match(markup, /class="size-cell">—</);
  assert.match(markup, /aria-selected="true"/);
  assert.match(markup, /data-delete="id&amp;|data-delete="id&quot;unsafe"/);
  assert.match(markup, /disabled>Delete/);
  assert.match(
    renderTreeRows([{ ...row, worktree: { ...row.worktree, pending: true } }], {
      ...options,
      cancelled: true,
    }),
    /Scan incomplete/,
  );
});

test("selection reconciles provisional IDs by path and clears vanished anchors", async () => {
  const { reconcileSelection } = await import("../renderer/selection.mjs");
  const previous = [
    { id: "pending", path: "/one" },
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
});

test("exclusion editor preserves literal commas and patterns", async () => {
  const { readExcludes } = await import(
    "../renderer/preferences-controller.mjs"
  );
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
  const workspace = {
    snapshot: { setupRequired: true, root: "/local" },
    resetting: false,
    async completeSetup(options) {
      calls.push(options);
      await request.promise;
      workspace.snapshot.setupRequired = false;
    },
  };
  const preferences = {
    theme: "system",
    options: { excludes: ["cache"] },
    setTheme() {},
    recordScan() {},
    async save() {},
    completeSetup() {},
    syncOptions() {},
  };
  const controller = createSetupController({
    document,
    api: {},
    defaults: { excludes: ["cache"] },
    preferences,
    getWorkspace: () => workspace,
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

function dialogFixture() {
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
      listeners.close?.();
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
  return { document, dialog, content, footer };
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

async function workspaceFixture(overrides = {}) {
  const { createWorkspaceController } = await import(
    "../renderer/workspace-controller.mjs"
  );
  let timerID = 0;
  const pendingTimers = new Map(),
    savedScans = [],
    notifications = [];
  const initial = {
    host: "",
    root: "/local",
    busy: false,
    revision: "initial",
    report: { worktrees: [], warnings: [] },
  };
  const preferences = {
    options: { github: false, fetch: false, excludes: [] },
    initialize() {},
    syncOptions() {},
    recordScan(options) {
      savedScans.push(options);
    },
    async save() {},
    reset() {},
  };
  const api = {
    async getPreferences() {
      return {};
    },
    async getState() {
      return initial;
    },
    ...overrides,
  };
  const workspace = createWorkspaceController({
    api,
    preferences,
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

test("workspace ignores a poll from before an explicit scan", async () => {
  const oldPoll = deferred(),
    newScan = deferred();
  const fixture = await workspaceFixture({ scan: () => newScan.promise });
  fixture.api.getState = () => oldPoll.promise;
  const poll = [...fixture.pendingTimers.values()][0]();
  const scan = fixture.workspace.scan({ root: "/new", host: "" });
  oldPoll.resolve({ root: "/stale", busy: false, revision: "stale" });
  await poll;
  assert.equal(fixture.workspace.snapshot.busy, true);
  assert.notEqual(fixture.workspace.snapshot.root, "/stale");
  newScan.resolve({ root: "/new", host: "", busy: false, revision: "new" });
  await scan;
  assert.equal(fixture.workspace.snapshot.root, "/new");
  assert.equal(fixture.savedScans.length, 1);
  fixture.workspace.dispose();
});

test("later workspace activation wins over an older asynchronous reply", async () => {
  const old = deferred(),
    latest = deferred(),
    requests = [old, latest];
  const fixture = await workspaceFixture({
    activateWorkspace: () => requests.shift().promise,
  });
  const first = fixture.workspace.scan({ root: "~", host: "one" }, true);
  const second = fixture.workspace.scan({ root: "~", host: "two" }, true);
  latest.resolve({ root: "/two", host: "two", busy: false, revision: "two" });
  await second;
  old.resolve({ root: "/one", host: "one", busy: false, revision: "one" });
  await first;
  assert.equal(fixture.workspace.snapshot.host, "two");
  assert.deepEqual(
    fixture.savedScans.map((options) => options.host),
    ["two"],
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
