"use strict";
const { assert } = require("./harness.cjs");
const saved = (t) => JSON.parse(t.fixture.read("user-data/preferences.json"));
const cache = (t) => JSON.parse(t.fixture.read("user-data/workspace-cache.json"));
const scans = (t) => t.fixture.cliCalls().filter((args) => args[0] === "list");
const open = (t, id) => t.until(() => t.js(`document.querySelector('#${id}').open`), `${id} opens`);
const closed = (t, id) => t.until(() => t.js(`!document.querySelector('#${id}').open`), `${id} closes`);
async function select(t, selector, index) {
  // Native select popups are controlled with the keyboard, not page mutation.
  await t.click(selector);
  await t.press("Escape");
  await t.press("Home");
  if (index) await t.press("Down", { times: index });
  await t.press("Enter");
}
async function machine(t, host) {
  await t.click("#machine-button");
  await t.until(() => t.visible("#host-menu"), "host dropdown opens");
  const names = await t.texts('#host-menu [role="menuitemradio"]');
  const index = host === null ? 0 : host === "" ? 1 : names.findIndex(name => name.includes(host));
  await t.click(`#host-menu [data-choice="${index}"]`);
  await t.until(async () => (await t.state()).hostFilter === host, "machine changes");
}
async function noScan(t) {
  assert.equal(scans(t).length, 0);
  assert.deepEqual(t.fixture.connections(), []);
  assert.equal(t.fixture.exists("user-data/workspace-cache.json"), false);
  assert.equal(t.fixture.statistics(), null);
}
async function cached(t, path) {
  await t.until(() => cache(t).entries.some((entry) => entry.report.worktrees.some((row) => row.path === path)), "worktree saved in cache");
}
module.exports = { saved, cache, scans, open, closed, select, machine, noScan, cached };

// Electron's built-in roles need the focused WebContents as click's third
// argument. t.menu passes {}, which works for Arbor callbacks but throws
// for roles such as Select All. Keep this adapter here until the harness
// supplies the same native-menu signature.
async function menuRole(t, role) {
  const { Menu } = require("electron");
  const find = (items) => {
    for (const item of items) {
      if (item.role === role) return item;
      const child = item.submenu && find(item.submenu.items);
      if (child) return child;
    }
  };
  const item = find(Menu.getApplicationMenu().items);
  assert.ok(item && item.enabled, `enabled native menu role ${role}`);
  item.click(item, t.window, t.page, {});
  if (!["close", "quit"].includes(role) && !t.window.isDestroyed()) await t.painted();
}
module.exports.menuRole = menuRole;

// t.press repeats complete presses. This is one held key, with native repeat
// events between its down and up, so consent must survive a hurried typist.
async function holdEnter(t, repeats = 6) {
  try {
    for (let index = 0; index <= repeats; index++) {
      t.page.sendInputEvent({ type: "keyDown", keyCode: "Enter", isAutoRepeat: index > 0 });
      t.page.sendInputEvent({ type: "char", keyCode: "\r", isAutoRepeat: index > 0 });
      await t.painted();
    }
  } finally {
    t.page.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  }
}
module.exports.holdEnter = holdEnter;
