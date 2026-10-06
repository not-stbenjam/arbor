"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { removalConfirmationOptions: options } = require("./removal-confirmation.cjs");
const { LOSSES } = require("./common/losses.mjs");
const row = { id: "topic", path: "/work/topic", canRemove: false, canDiscard: true };
const words = (s) => s.trim().split(/\s+/).length;

test("ordinary single confirmations name losses once within 25 words and retain button positions", () => {
  for (const losses of [["ignored"], ["changes"], ["changes", "ignored"], ["unchecked"], ["changes", "ignored", "unchecked"]]) {
    const answer = options([{ ...row, losses }], true);
    assert.deepEqual(answer, {
      title: "Delete worktree?",
      message: `Delete “topic” and its ${losses.map((name) => LOSSES[name].brief).join(" and ")}?`,
      detail: "Its branch and commits are kept.\n\n/work/topic",
      buttons: ["Cancel", "Delete", "Show Files…"],
    });
    assert.ok(words(answer.message + " " + answer.detail.replace(row.path, "")) <= 25);
  }
});

test("forced deletion names the lock and covers new ordinary files even with no cached losses", () => {
  for (const facts of [{ locked: true }, { detached: true }, { branch: "develop" }]) {
    const answer = options([{ ...row, ...facts, losses: [] }], true);
    assert.equal(answer.message, "Delete “topic”?");
    assert.match(answer.detail, /Any uncommitted files are discarded\./);
    // One on no branch has none to keep.
    assert.match(answer.detail, facts.detached ? /Its commits are kept\./ : /Its branch and commits are kept\./);
    assert.equal(answer.detail.includes("Lock overridden."), !!facts.locked);
    assert.deepEqual(answer.buttons, ["Cancel", "Delete"]);
    assert.ok(words(answer.message + " " + answer.detail.replace(row.path, "")) <= 25);
  }
  assert.doesNotMatch(options([{ ...row, canRemove: true }], true).detail, /discarded/);
});

test("grave losses each have a separate permanent-loss line, never a promise to retain all commits", () => {
  for (const name of ["nested", "submodules", "operation", "refs"]) {
    const answer = options([{ ...row, losses: ["ignored", name] }], true);
    assert.equal(answer.message, "Delete “topic” and its ignored files?");
    assert.equal(answer.detail, `Permanently loses:\n• ${LOSSES[name].text}\nParent repository branches are kept.\n\n/work/topic`);
    assert.deepEqual(answer.buttons, ["Cancel", "Delete", "Show Files…"]);
    assert.doesNotMatch(answer.detail, /commits are kept/);
  }
  const answer = options([{ ...row, losses: Object.keys(LOSSES) }], true);
  for (const name of ["nested", "submodules", "operation", "refs"])
    assert.ok(answer.detail.split("\n").includes(`• ${LOSSES[name].text}`));
});

test("missing and empty folders suppress ordinary losses but retain grave losses and lock overrides", () => {
  for (const missing of [false, true]) {
    const tree = { ...row, missing, empty: !missing, locked: true, losses: ["ignored", "submodules"] };
    const answer = options([tree], true);
    assert.match(answer.detail, /submodules and their unpushed commits/);
    assert.match(answer.detail, /Lock overridden/);
    assert.doesNotMatch(answer.message + answer.detail, /ignored|Any uncommitted/);
    assert.equal(answer.message, missing ? "Remove registration for “topic”?" : "Delete “topic”?");
    assert.equal(answer.buttons[1], missing ? "Remove Registration" : "Delete");
    const plain = options([{ ...tree, losses: [] }], true);
    assert.equal(plain.buttons.length, 2);
    if (missing) assert.match(plain.detail, /Folder already gone; only registration removed/);
  }
  assert.match(options([{ ...row, missing: true }, { ...row, canRemove: true }], true).detail, /1 missing folder: registration only/);
});

test("remote hosts are named, including hosts outside the bounded preview", () => {
  const remote = options([{ ...row, host: "vps", hostLabel: "Build server", losses: ["ignored"] }], true);
  assert.equal(remote.detail, "On Build server [vps].\nIts branch and commits are kept.\n\n/work/topic");
  assert.ok(words(remote.message + " " + remote.detail.replace(row.path, "")) <= 25);
  const mixed = options([{ ...row, host: "" }, { ...row, host: "vps" }], true);
  assert.equal(mixed.message, "Delete 2 worktrees on 2 hosts?");
  assert.match(mixed.detail, /This computer: \/work\/topic/);
  assert.match(mixed.detail, /vps: \/work\/topic/);
  const many = options(Array.from({ length: 101 }, (_, i) => ({ ...row, host: `host-${i}`, hostLabel: "long ".repeat(100) })), true);
  assert.match(many.message, /on 101 hosts/);
  assert.match(many.detail, /and 97 more hosts/);
  assert.ok(many.detail.length < 1500);
});

test("bulk preview is bounded, sanitized, grave-first, and describes only consented losses", () => {
  const trees = [
    ...Array.from({ length: 8 }, (_, i) => ({ ...row, path: `/work/clean-${i}`, canRemove: true })),
    { ...row, path: "/work/dirty", losses: ["changes"] },
    { ...row, path: "/work/held", locked: true },
    { ...row, path: "/work/deps", losses: ["ignored"] },
    { ...row, path: "/work/repo", losses: ["nested"] },
  ];
  const answer = options(trees, true);
  assert.equal(answer.message, "Delete 12 worktrees?");
  assert.deepEqual(answer.detail.split("\n\n")[1].split("\n"), [
    "/work/repo — nested repository", "/work/dirty — uncommitted changes", "/work/held — locked", "/work/deps — ignored files", "/work/clean-0", "and 7 more selected worktrees",
  ]);
  assert.deepEqual(answer.buttons, ["Cancel", "Delete"]);
  assert.doesNotMatch(options(trees, false).detail, /ignored|uncommitted|nested|Permanently|overridden/);
  const long = options(Array.from({ length: 1000 }, () => ({ ...row, path: `/work/${"long-folder/".repeat(100)}line\nend`, losses: Object.keys(LOSSES), locked: true })), true);
  assert.ok(long.detail.length < 1700);
  const previews = long.detail.split("\n").filter((line) => line.startsWith("/work/"));
  assert.equal(previews.length, 5);
  assert.ok(previews.every((line) => Array.from(line).length <= 120));
  assert.equal(long.detail.match(/Locks overridden/g).length, 1);
  assert.equal(long.detail.match(/^• /gm).length, 4);
  assert.match(long.detail, /and 995 more selected worktrees/);
  assert.ok(long.message.length < 100);
});
