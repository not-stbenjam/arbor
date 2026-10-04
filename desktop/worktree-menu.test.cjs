"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  menuTarget,
  terminalCommand,
  removalConfirmationOptions,
} = require("./worktree-menu.cjs");

const row = { id: "topic", path: "/work/topic", canRemove: true };
const state = {
  revision: "revision-1",
  host: "",
  busy: false,
  report: { worktrees: [row] },
};

test("native menu resolves the current row rather than a renderer supplied path", () => {
  const target = menuTarget(state, {
    id: row.id,
    revision: state.revision,
    path: "/arbitrary",
  });
  assert.equal(target.path, row.path);
  assert.equal(target.local, true);
  assert.equal(target.removable, true);
  for (const value of [
    null,
    [],
    { id: "missing", revision: state.revision },
    { id: row.id, revision: "old" },
    { id: row.id },
  ])
    assert.throws(() => menuTarget(state, value));
});

test("partial rows can be copied but cannot enable deletion", () => {
  const target = menuTarget(
    {
      revision: null,
      host: "",
      busy: true,
      report: null,
      partialWorktrees: [row],
    },
    { id: row.id, revision: null },
  );
  assert.equal(target.path, row.path);
  assert.equal(target.local, true);
  assert.equal(target.removable, false);
});

test("remote and missing rows cannot launch local applications", () => {
  assert.equal(
    menuTarget(
      { ...state, host: "vps" },
      { id: row.id, revision: state.revision },
    ).local,
    false,
  );
  assert.equal(
    menuTarget(
      { ...state, report: { worktrees: [{ ...row, missing: true }] } },
      { id: row.id, revision: state.revision },
    ).local,
    false,
  );
  assert.throws(() =>
    menuTarget(
      { ...state, report: { worktrees: [{ ...row, path: "bad\0path" }] } },
      { id: row.id, revision: state.revision },
    ),
  );
});

test("manual-discard candidates get a delete action but outside-root entries do not", () => {
  const source = {
    ...state,
    report: { worktrees: [{ ...row, canRemove: false, canDiscard: true }] },
  };
  assert.equal(
    menuTarget(source, { id: row.id, revision: state.revision }).removable,
    true,
  );
  source.report.worktrees[0].outsideRoot = true;
  assert.equal(
    menuTarget(source, { id: row.id, revision: state.revision }).removable,
    false,
  );
});

test("macOS Terminal receives opaque directory arguments, never shell commands", () => {
  const directory = "/work/a'; $(touch nope)\nnext";
  const command = terminalCommand("darwin", directory, () =>
    assert.fail("must use fixed system launcher"),
  );
  assert.equal(command.binary, "/usr/bin/open");
  assert.deepEqual(command.args, [
    "-a",
    "/System/Applications/Utilities/Terminal.app",
    "--",
    directory,
  ]);
  assert.equal(command.cwd, directory);
});

test("Linux terminals use argv or cwd without shell interpolation", () => {
  const directory = "/work/$(command);\nhello";
  const gnome = terminalCommand("linux", directory, (name) =>
    name === "gnome-terminal" ? "/usr/bin/gnome-terminal" : null,
  );
  assert.deepEqual(gnome.args, [`--working-directory=${directory}`]);
  const xterm = terminalCommand("linux", directory, (name) =>
    name === "xterm" ? "/usr/bin/xterm" : null,
  );
  assert.deepEqual(xterm.args, []);
  assert.equal(xterm.cwd, directory);
  assert.equal(
    terminalCommand("linux", directory, () => null),
    null,
  );
  assert.throws(() => terminalCommand("linux", "relative", () => null));
  assert.throws(() => terminalCommand("linux", "/bad\0path", () => null));
});

test("modern Linux terminal launchers preserve opaque working directories", () => {
  const directory = "/work/a'; $(do-not-run)\nline";
  const expected = {
    ptyxis: ["--new-window", `--working-directory=${directory}`],
    kgx: [`--working-directory=${directory}`],
    kitty: ["--directory", directory],
    alacritty: ["--working-directory", directory],
    foot: [`--working-directory=${directory}`],
    wezterm: ["start", "--cwd", directory],
    ghostty: [
      `--working-directory=${directory}`,
      "--window-inherit-working-directory=false",
    ],
  };
  for (const [name, args] of Object.entries(expected)) {
    const command = terminalCommand("linux", directory, (candidate) =>
      candidate === name ? "/usr/bin/" + name : null,
    );
    assert.deepEqual(command.args, args);
    assert.equal(command.cwd, directory);
  }
});

test("confirmation names detached worktree folders and does not invent local file loss", () => {
  const cleanDetached = removalConfirmationOptions(
    [{ ...row, branch: "", detached: true }],
    true,
  );
  assert.equal(cleanDetached.message, "Remove “topic”?");
  assert.equal(cleanDetached.title, "Remove worktree?");
  assert.match(cleanDetached.detail, /recovery branches/);
  assert.match(cleanDetached.detail, /only if needed/);
  assert.doesNotMatch(
    cleanDetached.detail,
    /files will be permanently discarded/,
  );
  const cleanProtected = removalConfirmationOptions(
    [{ ...row, branch: "develop" }],
    true,
  );
  assert.doesNotMatch(cleanProtected.detail, /discarded|recovery branches/);
  const locked = removalConfirmationOptions([{ ...row, locked: true }], true);
  assert.match(locked.detail, /locks.*overridden/);
  assert.doesNotMatch(locked.detail, /files will be permanently discarded/);
});

test("confirmation describes only actual local-file categories", () => {
  const dirty = removalConfirmationOptions([{ ...row, dirty: true }], true);
  assert.equal(dirty.title, "Discard local data and remove?");
  assert.match(dirty.detail, /Uncommitted and untracked files/);
  assert.doesNotMatch(dirty.detail, /ignored files/i);
  const ignored = removalConfirmationOptions([{ ...row, ignored: true }], true);
  assert.match(ignored.detail, /Ignored files/);
  assert.doesNotMatch(ignored.detail, /uncommitted/i);
});

test("failed inspections expose a targeted native retry without enabling stale deletion", () => {
  const failed = {
    ...state,
    report: {
      worktrees: [{ ...row, canRemove: false, retryInspection: true }],
    },
  };
  const target = menuTarget(failed, { id: row.id, revision: failed.revision });
  assert.equal(target.retryInspection, true);
  assert.equal(target.removable, false);
  assert.equal(
    menuTarget(
      { ...failed, busy: true },
      { id: row.id, revision: failed.revision },
    ).retryInspection,
    false,
  );
});
