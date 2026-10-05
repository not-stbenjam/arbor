"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const tree = require("./worktree-tree.mjs");
const row = (host, id, extra = {}) => ({
  host,
  id: JSON.stringify([host, id]),
  sourceID: id,
  path: "/work/shared",
  commonDir: "/repo/.git",
  repo: "repo",
  branch: "topic",
  head: "a",
  canRemove: true,
  recommended: true,
  ...extra,
});
const hosts = [
  { host: "", label: "This computer", root: "/work" },
  { host: "vps", label: "Build server", root: "/work" },
];
const projection = {
  root: "",
  hostFilter: null,
  hosts,
  search: "",
  sort: "path",
  view: "all",
  collapsedDirectories: new Set(),
};

test("All-host repository labels distinguish machines without changing IDs or adding badges", async () => {
  const { projectRepositories, renderRepositoryList } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const local = row("", "local"),
    remote = row("vps", "remote"),
    secondRemote = row("vps", "second");
  const all = projectRepositories([local, remote, secondRemote], {
    hostFilter: null,
    hosts,
  });
  assert.deepEqual(
    all.map((entry) => [entry.name, entry.count]),
    [
      ["repo · Build server", 2],
      ["repo · This computer", 1],
    ],
  );
  const remoteGroup = all.find((entry) => entry.count === 2);
  assert.equal(remoteGroup.id, tree.repositoryKey(remote));
  assert.equal(remoteGroup.title, "vps:/repo/.git");
  const single = projectRepositories([remote, secondRemote], {
    hostFilter: "vps",
    hosts,
  });
  assert.equal(single[0].name, "repo");
  assert.equal(single[0].id, remoteGroup.id);
  assert.equal(
    projectRepositories([local], { hostFilter: "", hosts })[0].name,
    "repo",
  );
  const escaped = projectRepositories(
    [row("vps", "unsafe", { repo: "<repo>" })],
    { hostFilter: null, hosts: [{ host: "vps", label: "<Build & test>" }] },
  );
  const markup = renderRepositoryList(escaped, escaped[0].id);
  assert.match(markup, /&lt;repo&gt; · &lt;Build &amp; test&gt;/);
  assert.match(markup, /class="repo-item active"/);
  assert.doesNotMatch(markup, /badge|<repo>|<Build/);
});

test("deletion failures identify machines sharing the same checkout path", async () => {
  const { createWorkspaceController } = await import(
    "../renderer/workspace-controller.mjs"
  );
  const worktree = row("vps", "failed");
  const state = {
    report: { worktrees: [worktree] },
    revision: "current",
    hostFilter: null,
    hosts,
    busy: false,
  };
  const workspace = createWorkspaceController({
    api: {
      async getState() {
        return state;
      },
      async remove() {
        return {
          results: [
            {
              host: "",
              path: "/work/shared",
              removed: false,
              error: "Local failure",
            },
            {
              host: "vps",
              path: "/work/shared",
              removed: false,
              error: "Remote failure",
            },
            { path: "/legacy", removed: false, error: "Legacy failure" },
          ],
        };
      },
    },
    linked: (values) => values,
    notify() {},
    onChange() {},
    onSetup() {},
    onHostChange() {},
    onReset() {},
    timers: {
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
    },
  });
  await workspace.initialize();
  await workspace.remove([worktree], false);
  assert.equal(
    workspace.error,
    "This computer:/work/shared: Local failure\nvps:/work/shared: Remote failure\n/legacy: Legacy failure",
  );
  workspace.dispose();
});

test("All machines preserves separate paths, repository filters, counts and folder scopes", async () => {
  const { projectTree, renderTreeRows } = await import(
    "../renderer/worktree-presentation.mjs"
  );
  const { repoID } = await import("../renderer/presentation.mjs");
  const local = row("", "same"),
    remote = row("vps", "same"),
    pending = row("vps", "new", {
      path: "/work/new",
      pending: true,
      recommended: false,
    });
  const values = [remote, pending, local];
  const all = projectTree(values, projection, tree);
  assert.deepEqual(
    all.directoryRows
      .filter((entry) => entry.kind === "host")
      .map((entry) => [entry.host, entry.label, entry.descendants.length]),
    [
      ["", "This computer", 1],
      ["vps", "Build server", 2],
    ],
  );
  assert.deepEqual(
    tree.folderWorktrees(all.directoryRows, tree.scopedKey("", "/work")),
    [local],
  );
  assert.deepEqual(
    tree.folderWorktrees(all.directoryRows, tree.scopedKey("vps", "/work")),
    [pending, remote],
  );
  assert.deepEqual(
    tree.folderWorktrees(all.directoryRows, "/work"),
    [],
    "unscoped paths cannot target combined results",
  );
  assert.notEqual(repoID(local), repoID(remote));
  assert.equal(repoID(remote), tree.repositoryKey(remote));
  assert.deepEqual(
    projectTree(values, { ...projection, repo: repoID(local) }, tree).visible,
    [local],
  );
  assert.deepEqual(
    projectTree(values, { ...projection, search: "vps" }, tree).visible.map(
      (entry) => entry.host,
    ),
    ["vps", "vps"],
  );
  assert.equal(
    projectTree(values, { ...projection, view: "recommended" }, tree).visible
      .length,
    2,
  );
  const collapsed = projectTree(
    values,
    {
      ...projection,
      collapsedDirectories: new Set([tree.scopedKey("vps", "/work")]),
    },
    tree,
  );
  assert.deepEqual(collapsed.visible, [local]);
  const collapsedHost = projectTree(
    values,
    { ...projection, collapsedDirectories: new Set([JSON.stringify([""])]) },
    tree,
  );
  assert.equal(
    collapsedHost.visible.every((entry) => entry.host === "vps"),
    true,
  );
  const filtered = projectTree(
    [remote],
    { ...projection, root: "/work", hostFilter: "vps" },
    tree,
  );
  assert.equal(
    filtered.directoryRows.some((entry) => entry.kind === "host"),
    false,
  );
  assert.equal(
    filtered.directoryRows[0].node.key,
    tree.scopedKey("vps", "/work"),
  );
  const markup = renderTreeRows(all.directoryRows, {
    selected: new Set([local.id]),
    collapsed: new Set(),
    disabled: false,
    canDelete: (entry) => !entry.pending,
  });
  assert.match(markup, /class="directory-row host-row" data-host="vps"/);
  assert.match(
    markup,
    /data-folder-delete="\[&quot;vps&quot;,&quot;\/work&quot;\]"/,
  );
  assert.match(
    markup,
    /data-delete="\[&quot;vps&quot;,&quot;new&quot;\]"[^>]*disabled/,
  );
  assert.doesNotMatch(
    markup,
    /data-delete="\[&quot;&quot;,&quot;same&quot;\]"[^>]*disabled/,
  );
});

test("provisional selection bridges never cross machines with the same path", async () => {
  const { reconcileSelection } = await import("../renderer/selection.mjs");
  const local = row("", "temporary", { pending: true });
  const selection = {
    ids: new Set([local.id]),
    anchor: local.id,
    cursor: local.id,
  };
  assert.equal(
    reconcileSelection([local], [row("vps", "registered")], selection).ids.size,
    0,
  );
  const next = row("", "registered");
  assert.deepEqual(
    [
      ...reconcileSelection(
        [local, row("vps", "temporary", { pending: true })],
        [next, row("vps", "registered")],
        selection,
      ).ids,
    ],
    [next.id],
  );
});

test("scan activity lists only hosts with something to report, with independent stop buttons and safe labels", async () => {
  const { hostProgress } = await import("../renderer/host-progress.mjs");
  const scanning = {
    ...hosts[1],
    label: "<Build>",
    busy: true,
    canCancelScan: true,
    progress: {
      stage: "inspect",
      path: "/work/<pending>",
      completed: 1,
      total: 3,
    },
  };
  const result = hostProgress([
    { ...hosts[0], report: { worktrees: [] } },
    scanning,
    { host: "offline", error: "Connection <failed>" },
    { host: "paused", label: "Paused", cancelled: true, root: "/srv" },
  ]);
  assert.equal(result.active, 1);
  assert.equal(result.visible, true);
  assert.equal(result.canCancel, true);
  assert.equal(result.canCancelAll, false, "one scan needs only its own Stop");
  assert.match(result.markup, /data-stop-host="vps"/);
  assert.doesNotMatch(result.markup, /data-stop-host=""/);
  assert.match(result.markup, /&lt;Build&gt;/);
  // The count is its own element, so a long path cannot push it out of view.
  assert.match(
    result.markup,
    /host-progress-path" title="\/work\/&lt;pending&gt;">\/work\/&lt;pending&gt;<\/span><span class="host-progress-count">1 of 3<\/span>/,
  );
  assert.match(
    result.markup,
    /data-progress-host="paused"[^]*Scan stopped[^]*The list is incomplete\. Refresh to scan again\./,
  );
  assert.match(
    hostProgress([{ host: "", cancelled: true, report: { root: "/work" } }])
      .markup,
    /Showing the results of the last completed scan\./,
  );
  assert.doesNotMatch(result.markup, /<Build>|<pending>/);
  // An idle host has nothing to report, and a failure is the banner's to say
  // once, not repeated here.
  assert.doesNotMatch(result.markup, /This computer|offline|Connection/);
  assert.equal(
    hostProgress([hosts[0], { host: "offline", error: "unreachable" }]).visible,
    false,
  );
  const several = hostProgress([
    scanning,
    { host: "other", busy: true, canCancelScan: true },
    { host: "stopping", busy: true, cancelRequested: true },
  ]);
  assert.equal(several.active, 3);
  assert.equal(several.canCancelAll, true);
  assert.match(several.markup, /data-stop-host="stopping" disabled/);
});

test("background scans allow filter navigation and verified deletion, with host-scoped refresh and cancellation", async () => {
  const { createWorkspaceController } = await import(
    "../renderer/workspace-controller.mjs"
  );
  const local = row("", "cached"),
    pending = row("vps", "new", { pending: true });
  let state = {
    host: "",
    hostFilter: "",
    root: "/work",
    revision: "snapshot",
    busy: false,
    report: { worktrees: [local] },
    hosts: [
      hosts[0],
      { ...hosts[1], busy: true, canCancelScan: true, operation: "scan" },
    ],
  };
  const calls = [];
  const workspace = createWorkspaceController({
    api: {
      async getState() {
        return state;
      },
      async setHostFilter(value) {
        calls.push(["filter", value]);
        state = {
          ...state,
          hostFilter: value,
          busy: true,
          report: { worktrees: [local, pending] },
        };
        return state;
      },
      async refreshHosts(value) {
        calls.push(["refresh", value]);
        return state;
      },
      async cancelScan(value) {
        calls.push(["cancel", value]);
        return state;
      },
      async remove(value) {
        calls.push(["remove", value]);
        return { results: [{ path: local.path, removed: true }] };
      },
    },
    linked: (values) => values,
    notify() {},
    onChange() {},
    onSetup() {},
    onHostChange() {},
    onReset() {},
    timers: {
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
    },
  });
  await workspace.initialize();
  assert.equal(workspace.blocked, false);
  await workspace.setHostFilter(null);
  assert.equal(workspace.snapshot.busy, true);
  assert.equal(workspace.blocked, false);
  assert.equal(workspace.canDelete(local), true);
  assert.equal(workspace.canDelete(pending), false);
  await workspace.refresh();
  await workspace.cancel("vps");
  await workspace.deleteWorktrees([local]);
  assert.deepEqual(calls.slice(0, 3), [
    ["filter", null],
    ["refresh", null],
    ["cancel", "vps"],
  ]);
  assert.equal(calls[3][0], "remove");
  assert.deepEqual(calls[3][1].items, [{ id: local.id, head: local.head }]);
  assert.equal(calls[3][1].revision, "snapshot");
  assert.equal(
    workspace.snapshot.hosts[1].busy,
    true,
    "other host remains active after local cleanup",
  );
  workspace.dispose();
});

test("a stopped-host reply cannot restore an old filter after navigation", async () => {
  const { createWorkspaceController } = await import(
    "../renderer/workspace-controller.mjs"
  );
  let finishCancel;
  const initial = {
    hostFilter: "vps",
    host: "vps",
    busy: true,
    report: { worktrees: [] },
    hosts: [{ host: "vps", busy: true, canCancelScan: true }],
  };
  const workspace = createWorkspaceController({
    api: {
      async getState() {
        return initial;
      },
      cancelScan() {
        return new Promise((resolve) => {
          finishCancel = resolve;
        });
      },
      async setHostFilter(hostFilter) {
        return { ...initial, hostFilter, host: "", busy: false };
      },
    },
    linked: (values) => values,
    notify() {},
    onChange() {},
    onSetup() {},
    onHostChange() {},
    onReset() {},
    timers: {
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
    },
  });
  await workspace.initialize();
  const cancelling = workspace.cancel("vps");
  await workspace.setHostFilter("");
  finishCancel({ ...initial, busy: false });
  await cancelling;
  assert.equal(workspace.snapshot.hostFilter, "");
  workspace.dispose();
});
