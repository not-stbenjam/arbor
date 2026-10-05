"use strict";

const fs = require("node:fs");
const { assert } = require("./harness.cjs");

const leaves = async (t) => (await t.rows()).filter((row) => !row.folder);
const names = async (t) => t.texts("#worktree-list .path-basename");
async function shown(t, expected) {
  await t.until(async () => JSON.stringify(await names(t)) === JSON.stringify(expected), `rows ${expected.join(", ")}`);
}
async function search(t, value) {
  await t.click("#search");
  await t.press("Control+a");
  if (value) await t.type(value);
  else await t.press("Backspace");
}
async function selected(t, expected) {
  const rows = await leaves(t);
  assert.deepEqual(rows.filter((row) => row.ticked).map((row) => row.text.split(" ")[0]).sort(), [...expected].sort());
  assert.equal(await t.visible("#selection-bar"), expected.length > 0);
}
function registered(t, repository, target) {
  return t.fixture.git(repository, "worktree", "list", "--porcelain", "-z").split("\0").includes(`worktree ${target}`);
}
async function gone(t, tree) {
  await t.until(async () => !t.fixture.exists(tree.path) && !(await t.exists(`tr[data-path=${JSON.stringify(tree.path)}]`)), `${tree.name} removed from disk and list`);
  await t.settled();
  assert.equal(registered(t, tree.repository, tree.path), false);
  if (tree.branch) assert.equal(t.fixture.git(tree.repository, "rev-parse", tree.branch), tree.head);
}
function record(tree) {
  return { name: tree.name, path: tree.path, branch: tree.branch, repository: tree.repository.path, head: tree.repository.head(tree.branch || "HEAD") };
}
async function statistics(t, count) {
  assert.equal(t.fixture.statistics().removedWorktrees, count);
  await t.click("#statistics-button");
  await t.until(async () => await t.text('[data-stat="removedWorktrees"]') === String(count), "visible cleanup total");
  await t.press("Escape");
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
// Hold exactly one real Git command at a named boundary. A FIFO lets the
// scenario release it after observing the UI, without guessing a duration.
// The subprocess still runs Git and the real Arbor CLI, with fixture HOME.
function gate(fixture, pattern) {
  const git = fixture.run("sh", ["-c", "command -v git"]).stdout.trim();
  const fifo = fixture.path("git-gate.fifo");
  assert.equal(fixture.run("mkfifo", [fifo]).status, 0);
  fixture.tool("git", [
    `case " $* " in *${quote(pattern)}*)`,
    `  if mkdir ${quote(fixture.path("gate-claimed"))} 2>/dev/null; then`,
    `    touch ${quote(fixture.path("gate-entered"))}`,
    `    read answer < ${quote(fifo)}`,
    "  fi;;",
    "esac",
    `exec ${quote(git)} "$@"`,
  ].join("\n"));
}
async function release(t) {
  await t.until(() => {
    try {
      const fd = fs.openSync(t.fixture.path("git-gate.fifo"), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      fs.writeSync(fd, "continue\n");
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error.code === "ENXIO") return false;
      throw error;
    }
  }, "release the waiting Git command", 2000);
}

// The virtual display has no window manager to consume Alt+F4. Ask Electron
// for the same native close event its titlebar would generate.
const closeWindow = (t) => t.window.close();

module.exports = { leaves, names, shown, search, selected, registered, gone, record, statistics, gate, release, closeWindow };
