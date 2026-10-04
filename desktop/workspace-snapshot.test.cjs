"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  globalID,
  parseGlobalID,
  SnapshotRevisions,
  displayedRows,
  workspaceSnapshot,
} = require("./workspace-snapshot.cjs");

const row = {
  id: "same-id",
  path: "/work/topic",
  commonDir: "/repo/.git",
  head: "a",
  branch: "topic",
  canRemove: true,
  recommended: true,
};
const host = (name, extra = {}) => ({
  host: name,
  label: name || "This computer",
  root: "/work",
  revision: `revision:${name}`,
  report: {
    root: "/work",
    worktrees: [row],
    warnings: [],
    scannedAt: "2026-10-04T00:00:00Z",
  },
  partialWorktrees: [],
  busy: false,
  cached: true,
  canCancelScan: false,
  ...extra,
});

test("global worktree identities round-trip without conflating hosts or delimiters", () => {
  for (const source of ["", "vps", "user@[::1]"]) {
    const id = globalID(source, 'id:["unicode-🌲"]');
    assert.deepEqual(parseGlobalID(id), {
      host: source,
      id: 'id:["unicode-🌲"]',
    });
  }
  assert.notEqual(globalID("", row.id), globalID("vps", row.id));
  for (const value of [
    null,
    "",
    "[]",
    globalID("vps", row.id) + "=",
    Buffer.from('["vps",3]').toString("base64url"),
  ])
    assert.throws(() => parseGlobalID(value), /Invalid worktree identity/);
});

test("aggregate revisions preserve each host's meaning and bound their history", () => {
  const revisions = new SnapshotRevisions();
  const hosts = [host(""), host("vps")];
  const before = revisions.capture(hosts);
  hosts[1].busy = true;
  assert.equal(revisions.capture(hosts), before);
  hosts[1].revision = "remote-new";
  const after = revisions.capture(hosts);
  assert.notEqual(after, before);
  assert.equal(revisions.native(before, ""), revisions.native(after, ""));
  assert.equal(revisions.native(before, "vps"), "revision:vps");
  assert.equal(revisions.native(after, "vps"), "remote-new");
  assert.throws(() => revisions.native(after, "unconfigured"), /list changed/);
  for (let i = 0; i < 128; i++) {
    hosts[1].revision = `new-${i}`;
    revisions.capture(hosts);
  }
  assert.throws(() => revisions.native(before, ""), /list changed/);
  revisions.clear();
  assert.throws(() => revisions.native(after, ""), /list changed/);
});

test("partial merging coalesces provisional paths but keeps separate registrations", () => {
  const source = host("vps", {
    partialWorktrees: [
      { ...row, branch: "new-unchecked" },
      { id: "temporary", path: row.path },
      { ...row, id: "different-registration" },
      { ...row, id: "new", path: "/work/new" },
      { id: "temporary-new", path: "/work/new" },
    ],
  });
  const rows = displayedRows(source);
  assert.deepEqual(
    rows.map((entry) => entry.sourceID),
    [row.id, "different-registration", "new"],
  );
  assert.equal(rows[0].branch, "topic");
  assert.equal(rows[0].nativeRevision, source.revision);
  for (const partial of rows.slice(1)) {
    assert.equal(partial.pending, true);
    assert.equal(partial.nativeRevision, null);
    assert.equal(partial.canRemove, false);
    assert.equal(partial.canDiscard, false);
    assert.equal(partial.recommended, false);
  }
});

test("workspace snapshots ship worktrees once and scope controls without hiding other host activity", () => {
  const hosts = [
    host(""),
    host("vps", {
      busy: true,
      canCancelScan: true,
      cached: false,
      error: "Connection unavailable",
    }),
  ];
  const options = {
    hostFilter: null,
    revision: "aggregate",
    setupRequired: false,
    removing: false,
  };
  const all = workspaceSnapshot(hosts, options);
  assert.equal(all.report.worktrees.length, 2);
  assert.equal(all.worktreeCount, 2);
  assert.equal(all.busy, true);
  assert.match(all.error, /vps: Connection unavailable/);
  assert.equal(all.cached, false);
  for (const summary of all.hosts) {
    assert.equal(summary.worktreeCount, 1);
    assert.equal(summary.report.root, "/work");
    assert.equal(Object.hasOwn(summary.report, "worktrees"), false);
    assert.equal(Object.hasOwn(summary, "partialWorktrees"), false);
  }
  const local = workspaceSnapshot(hosts, { ...options, hostFilter: "" });
  assert.equal(local.report.worktrees.length, 1);
  assert.equal(local.busy, false);
  assert.equal(local.canCancelScan, false);
  assert.equal(local.cached, true);
  assert.equal(local.error, "");
  assert.equal(local.hosts[1].busy, true);
  assert.equal(local.hosts[1].canCancelScan, true);
  assert.equal(
    hosts[0].report.worktrees.length,
    1,
    "projection never edits the input",
  );
});
