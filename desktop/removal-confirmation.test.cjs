"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { removalConfirmationOptions } = require("./removal-confirmation.cjs");

const row = { id: "topic", path: "/work/topic", canRemove: true };

test("combined cleanup previews identify each machine even for identical paths", () => {
  const options = removalConfirmationOptions(
    [
      { ...row, host: "" },
      { ...row, host: "build-vps" },
    ],
    false,
  );
  assert.match(options.detail, /This computer: \/work\/topic/);
  assert.match(options.detail, /build-vps: \/work\/topic/);
});

test("bulk mixed-host consent names hosts beyond the bounded path preview", () => {
  const trees = [
    ...Array.from({ length: 6 }, (_, i) => ({
      ...row,
      host: "",
      path: `/work/local-${i}`,
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      ...row,
      host: "vps",
      hostLabel: "Build server",
      path: `/work/remote-${i}`,
    })),
  ];
  const options = removalConfirmationOptions(trees, false);
  assert.equal(options.message, "Delete 8 worktrees on 2 hosts?");
  assert.match(
    options.detail,
    /Hosts: This computer: 6 · Build server \[vps\]: 2/,
  );
  assert.match(options.detail, /and 3 more selected worktrees/);
  const many = removalConfirmationOptions(
    Array.from({ length: 101 }, (_, i) => ({
      ...row,
      host: `host-${i}`,
      hostLabel: `Build machine ${i} ${"long ".repeat(100)}`,
    })),
    false,
  );
  assert.match(many.message, /on 101 hosts/);
  assert.match(many.detail, /and 97 more hosts/);
  assert.ok(
    many.detail.length < 1500,
    "many hosts cannot make native consent overflow the screen",
  );
});

test("confirmation follows force disposal even when detached and locked snapshots were clean", () => {
  const cleanDetached = removalConfirmationOptions(
    [{ ...row, branch: "", detached: true, canRemove: false }],
    true,
  );
  assert.equal(
    cleanDetached.message,
    "Delete “topic” and discard its local files?",
  );
  assert.equal(cleanDetached.title, "Discard local files and delete?");
  assert.equal(cleanDetached.buttons[1], "Discard & Delete");
  assert.match(cleanDetached.detail, /recovery branches/);
  assert.match(cleanDetached.detail, /only if needed/);
  assert.match(
    cleanDetached.detail,
    /Any local files.*will be permanently discarded/,
  );
  const cleanProtected = removalConfirmationOptions(
    [{ ...row, branch: "develop" }],
    true,
  );
  assert.doesNotMatch(cleanProtected.detail, /discarded|recovery branches/);
  const locked = removalConfirmationOptions(
    [{ ...row, locked: true, canRemove: false }],
    true,
  );
  assert.match(locked.detail, /locks.*overridden/);
  assert.match(locked.detail, /Any local files.*will be permanently discarded/);
});

test("force confirmation covers all local-file categories once, independent of cached contents", () => {
  const dirty = removalConfirmationOptions(
    [{ ...row, dirty: true, canRemove: false }],
    true,
  );
  assert.equal(dirty.title, "Discard local files and delete?");
  assert.match(dirty.detail, /uncommitted, untracked, and ignored files/);
  const ignored = removalConfirmationOptions(
    [{ ...row, ignored: true, canRemove: false }],
    true,
  );
  assert.match(ignored.detail, /uncommitted, untracked, and ignored files/);
});

test("bulk confirmation bounds long path previews and summarizes warnings once", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    ...row,
    canRemove: false,
    path: `/work/${"long-folder/".repeat(100)}line\n${index}\tend`,
    dirty: true,
    ignored: true,
    locked: true,
    detached: true,
    discardWarnings: Array(20).fill("Repeated per-worktree warning"),
  }));
  const options = removalConfirmationOptions(rows, true);
  assert.equal(
    options.message,
    "Delete 1000 worktrees and discard their local files?",
  );
  assert.ok(options.detail.length < 1500);
  assert.ok(options.detail.split("\n").length <= 13);
  const previews = options.detail
    .split("\n")
    .filter((line) => line.startsWith("/work/"));
  assert.equal(previews.length, 5);
  assert.ok(previews.every((line) => Array.from(line).length <= 120));
  assert.ok(previews.every((line) => !line.includes("\t")));
  assert.match(options.detail, /and 995 more selected worktrees/);
  assert.equal(options.detail.match(/permanently discarded/g)?.length, 1);
  assert.equal(options.detail.match(/locks.*overridden/g)?.length, 1);
  assert.equal(options.detail.match(/recovery branches/g)?.length, 1);
  assert.doesNotMatch(options.detail, /Repeated per-worktree warning/);
});

test("confirmation keeps exact short previews without inventing warnings", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ...row,
    path: `/work/tree-${index}`,
    discardWarnings: ["Ignored files will be discarded"],
  }));
  const options = removalConfirmationOptions(rows, true);
  assert.equal(options.message, "Delete 6 worktrees?");
  for (let index = 0; index < 5; index++)
    assert.ok(options.detail.includes(`/work/tree-${index}`));
  assert.doesNotMatch(options.detail, /tree-5/);
  assert.match(options.detail, /and 1 more selected worktree$/);
  assert.doesNotMatch(options.detail, /discarded|ignored|locks|recovery/i);
  const single = removalConfirmationOptions(
    [{ ...row, path: "/work/" + "a".repeat(1000) + "\nend" }],
    false,
  );
  assert.ok(single.message.length < 100);
  assert.doesNotMatch(single.message, /\n/);
});

test("missing-only confirmations remove registrations without claiming folder or data loss", () => {
  const missing = {
    ...row,
    canRemove: false,
    missing: true,
    dirty: true,
    ignored: true,
    locked: true,
  };
  const single = removalConfirmationOptions([missing], true);
  assert.equal(single.message, "Remove registration for “topic”?");
  assert.equal(single.buttons[1], "Remove Registration");
  assert.match(single.detail, /Only Git worktree registrations/);
  assert.doesNotMatch(
    single.detail,
    /folders are deleted|permanently discarded/,
  );
  assert.match(single.detail, /locks.*overridden/);
  const multiple = removalConfirmationOptions(
    [missing, { ...missing, path: "/work/other" }],
    true,
  );
  assert.equal(multiple.message, "Remove 2 missing worktree registrations?");
  const mixed = removalConfirmationOptions([missing, row], true);
  assert.match(
    mixed.detail,
    /1 missing worktree registration will also be removed/,
  );
  assert.match(mixed.detail, /folders are deleted permanently, not moved to Trash/);
  assert.doesNotMatch(mixed.detail, /permanently discarded/);
});

test("a large selection previews the worktrees that would lose files before the safe ones", () => {
  const clean = (index) => ({
    path: `/work/clean-${index}`,
    canRemove: true,
    canDiscard: true,
  });
  const risky = (name, facts) => ({
    path: `/work/${name}`,
    canRemove: false,
    canDiscard: true,
    ...facts,
  });
  const trees = [
    ...Array.from({ length: 8 }, (_, index) => clean(index)),
    risky("dirty", { dirty: true }),
    risky("held", { locked: true }),
    risky("deps", { ignored: true }),
    { path: "/work/gone", missing: true, dirty: true, canDiscard: true },
  ];
  const options = removalConfirmationOptions(trees, true);
  const preview = options.detail.split("\n\n")[1].split("\n");
  assert.deepEqual(preview, [
    "/work/dirty — uncommitted changes",
    "/work/held — locked",
    "/work/deps — ignored files",
    "/work/clean-0",
    "/work/clean-1",
    "and 7 more selected worktrees",
  ]);
  assert.match(
    options.detail,
    /At the last scan: 1 with uncommitted changes, 1 with ignored files only\./,
  );
  assert.equal(options.title, "Discard local files and delete?");
  assert.equal(options.buttons[1], "Discard & Delete");
  // Without consent to discard, nothing is discarded, so nothing is flagged.
  const kept = removalConfirmationOptions(trees.slice(0, 9), false);
  assert.doesNotMatch(kept.detail, /uncommitted|At the last scan/);
  assert.equal(kept.title, "Delete worktrees?");
  assert.equal(kept.buttons[1], "Delete Worktrees");
  // One worktree needs no tally; its own line already says what it has.
  const one = removalConfirmationOptions([trees[8]], true);
  assert.doesNotMatch(one.detail, /At the last scan/);
  assert.match(one.detail, /\/work\/dirty — uncommitted changes$/);
  assert.equal(one.message, "Delete “dirty” and discard its local files?");
});

test("the gravest consequence leads, and a single remote host is named up front", () => {
  const dirty = {
    path: "/srv/topic",
    host: "vps",
    hostLabel: "Build server",
    canRemove: false,
    canDiscard: true,
    dirty: true,
  };
  const lines = removalConfirmationOptions([dirty], true).detail.split("\n");
  assert.equal(lines[0], "On Build server [vps].");
  assert.match(lines[1], /^Any local files.*permanently discarded\.$/);
  assert.match(lines[2], /^Worktree folders are deleted permanently/);
  const local = removalConfirmationOptions(
    [{ ...dirty, host: "", hostLabel: "This computer" }],
    true,
  );
  assert.doesNotMatch(local.detail, /^On /, "this computer needs no naming");
  const clean = removalConfirmationOptions(
    [{ path: "/work/topic", canRemove: true, canDiscard: true }],
    true,
  );
  assert.equal(clean.message, "Delete “topic”?");
  assert.match(clean.detail, /^Worktree folders are deleted permanently/);
});

test("deleting several worktrees says the folders that hold them are kept", () => {
  const row = (name) => ({
    path: `/work/group/${name}`,
    canRemove: true,
    canDiscard: true,
  });
  assert.match(
    removalConfirmationOptions([row("a"), row("b")], false).detail,
    /Only these worktrees are deleted; a folder that holds them.*is kept\./,
  );
  // One worktree is its own folder; there is nothing else to reassure about.
  assert.doesNotMatch(
    removalConfirmationOptions([row("a")], false).detail,
    /a folder that holds them/,
  );
});
