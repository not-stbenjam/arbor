"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PreferencesStore } = require("./preferences-store.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-preferences-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "preferences.json");
}

test("preferences store serializes writes and only scan commands own scan/setup/history", async (t) => {
  const filename = fixture(t);
  const store = await PreferencesStore.open(filename);
  const stale = store.get();
  const scan = store.saveScan(
    { root: "/projects", host: "", excludes: ["build"] },
    { setupCompleted: true },
  );
  const editable = store.saveEditable({
    ...stale,
    theme: "dark",
    scan: { root: "/stale" },
    roots: ["/stale"],
    setupCompleted: false,
  });
  await Promise.all([scan, editable]);
  const value = store.get();
  assert.equal(value.theme, "dark");
  assert.equal(value.scan.root, "/projects");
  assert.deepEqual(value.scan.excludes, ["build"]);
  assert.deepEqual(value.roots, ["/projects"]);
  assert.equal(value.setupCompleted, true);
  assert.deepEqual((await PreferencesStore.open(filename)).get(), value);
  value.scan.excludes.push("changed");
  value.roots.length = 0;
  assert.deepEqual(store.get().scan.excludes, ["build"]);
  assert.deepEqual(store.get().roots, ["/projects"]);
  assert.deepEqual(store.get().scans, [store.get().scan]);
});

test("per-host choices survive editable saves, host removal, and restart without borrowing other host options", async (t) => {
  const filename = fixture(t);
  const store = await PreferencesStore.open(filename);
  await store.saveScan(
    {
      host: "",
      root: "/local",
      excludes: ["local"],
      github: false,
      fetch: false,
    },
    { setupCompleted: true },
  );
  const local = store.get().scan;
  await store.saveScan(
    {
      host: "remote",
      root: "/remote",
      excludes: [],
      github: true,
      fetch: true,
    },
    { setupCompleted: true },
  );
  const remote = store.get().scan;
  const stale = store.get();
  await store.saveEditable({
    ...stale,
    theme: "dark",
    scans: [{ host: "", root: "/spoofed" }],
  });
  assert.deepEqual(store.get().scans, [local, remote]);
  assert.deepEqual((await PreferencesStore.open(filename)).get().scans, [
    local,
    remote,
  ]);
  await store.saveEditable({ ...stale, hosts: [] });
  assert.deepEqual(store.get().scans, [local]);
  assert.deepEqual(
    store.get().scan,
    local,
    "forgotten last-selected host must not return on launch",
  );
  await store.reset();
  assert.equal(
    store.get().scans.some((scan) => scan.host === "remote"),
    false,
  );
});

test("setup persists host, theme and options once, and subsequent scans update host root", async (t) => {
  const filename = fixture(t);
  let changed = 0;
  const store = await PreferencesStore.open(filename, {
    onChange: () => changed++,
  });
  const host = "h".repeat(255);
  const initial = await store.saveScan(
    { root: "~/projects", host, excludes: [] },
    { setupCompleted: true, theme: "light" },
  );
  assert.equal(changed, 1);
  assert.equal(initial.theme, "light");
  assert.equal(initial.hosts[0].host, host);
  assert.equal(initial.hosts[0].name.length, 100);
  assert.deepEqual(initial.scan.excludes, []);
  await store.saveScan({ root: "~/other", host, excludes: [] });
  assert.equal(store.get().hosts.length, 1);
  assert.equal(store.get().hosts[0].root, "~/other");
  assert.deepEqual(store.get().roots, []);
  await assert.rejects(
    store.saveScan({ root: "/invalid" }, { theme: "invalid" }),
    /Invalid theme/,
  );
  assert.equal(store.get().scan.root, "~/other");
  assert.equal(changed, 2);
  await store.reset();
  assert.equal(store.get().setupCompleted, false);
  assert.equal(store.get().theme, "system");
  assert.deepEqual(store.get().hosts, []);
  assert.deepEqual((await PreferencesStore.open(filename)).get(), store.get());
});

test("failed atomic writes preserve state and do not poison the persistence queue", async (t) => {
  const filename = fixture(t);
  fs.mkdirSync(filename);
  const store = await PreferencesStore.open(filename);
  const before = store.get();
  await assert.rejects(store.saveScan({ root: "/unsaved" }));
  assert.deepEqual(store.get(), before);
  assert.deepEqual(
    fs.readdirSync(path.dirname(filename)),
    ["preferences.json"],
    "failed write leaves no temporary file",
  );
  fs.rmdirSync(filename);
  await store.saveScan({ root: "/saved" });
  assert.equal(store.get().scan.root, "/saved");
  assert.deepEqual((await PreferencesStore.open(filename)).get(), store.get());
});

test("stale editable preferences cannot overwrite a host's newer scan root", async (t) => {
  const filename = fixture(t);
  const store = await PreferencesStore.open(filename);
  await store.saveScan(
    { host: "vps", root: "~/old" },
    { setupCompleted: true },
  );
  const stale = store.get();
  await Promise.all([
    store.saveScan({ host: "vps", root: "~/current" }),
    store.saveEditable({
      ...stale,
      theme: "dark",
      hosts: [{ ...stale.hosts[0], name: "My VPS" }],
    }),
  ]);
  const value = store.get();
  assert.equal(value.theme, "dark");
  assert.deepEqual(value.hosts, [
    { host: "vps", name: "My VPS", root: "~/current" },
  ]);
  assert.equal(value.scan.root, "~/current");
  assert.deepEqual((await PreferencesStore.open(filename)).get(), value);
  await store.saveEditable({ ...value, hosts: [] });
  assert.deepEqual(
    store.get().hosts,
    [],
    "explicit forgetting still removes a host",
  );
});

test("local root history is bounded, recent-first and deduplicated across saves", async (t) => {
  const store = await PreferencesStore.open(fixture(t));
  for (let index = 0; index < 10; index++)
    await store.saveScan({ root: `/project-${index}` });
  await store.saveScan({ root: "/project-5" });
  assert.deepEqual(store.get().roots, [
    "/project-5",
    "/project-9",
    "/project-8",
    "/project-7",
    "/project-6",
    "/project-4",
    "/project-3",
    "/project-2",
  ]);
});
