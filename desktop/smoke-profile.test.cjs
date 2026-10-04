"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function loadMain(t, smoke) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-profile-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const normal = path.join(fixture, "normal-profile");
  fs.mkdirSync(normal);
  const sentinel = Buffer.from(
    "normal profile sentinel: must remain untouched\n",
  );
  const files = ["preferences.json", "workspace-cache.json", "statistics.json"];
  for (const file of files) fs.writeFileSync(path.join(normal, file), sentinel);
  const paths = { userData: normal, sessionData: normal };
  const env = { ARBOR_STATS_PATH: path.join(normal, "statistics.json") };
  if (smoke)
    Object.assign(env, { ARBOR_SMOKE_TEST: "1", ARBOR_SMOKE_ROOT: fixture });
  let ready = false;
  const app = {
    setPath(name, value) {
      assert.equal(ready, false, "profile must be redirected before readiness");
      paths[name] = value;
    },
    getPath: (name) => paths[name],
    setName() {},
    on() {},
    whenReady() {
      ready = true;
      return new Promise(() => {}); // Do not start windows or scan fixtures.
    },
  };
  const filename = path.join(__dirname, "main.cjs");
  const realRequire = createRequire(filename);
  const context = {
    require(name) {
      if (name === "electron") return { app };
      if (name === "node:os") return { ...os, tmpdir: () => fixture };
      return realRequire(name);
    },
    process: { env, argv: ["electron", "."], platform: process.platform },
    module: { exports: {} },
    __dirname,
    console,
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return { fixture, normal, paths, env, sentinel, files, ready };
}

test("smoke mode isolates app, session, and CLI statistics before readiness", (t) => {
  const { fixture, normal, paths, env, sentinel, files, ready } = loadMain(
    t,
    true,
  );
  assert.equal(ready, true);
  assert.notEqual(paths.userData, normal);
  assert.equal(path.dirname(paths.userData), fixture);
  assert.match(path.basename(paths.userData), /^arbor-smoke-profile-/);
  assert.equal(paths.sessionData, path.join(paths.userData, "session"));
  assert.equal(
    env.ARBOR_STATS_PATH,
    path.join(paths.userData, "statistics.json"),
  );
  assert.equal(fs.statSync(paths.userData).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.sessionData).mode & 0o777, 0o700);
  // Simulate the destinations used by cache/settings and CLI recording. All
  // writes are confined to the private smoke profile, including an inherited
  // ARBOR_STATS_PATH that originally pointed at the disposable normal profile.
  for (const file of files)
    fs.writeFileSync(path.join(paths.userData, file), "smoke fixture");
  fs.writeFileSync(env.ARBOR_STATS_PATH, "smoke totals");
  for (const file of files)
    assert.deepEqual(fs.readFileSync(path.join(normal, file)), sentinel);
  assert.deepEqual(fs.readdirSync(normal).sort(), [...files].sort());
});

test("ordinary app startup does not redirect its configured profile", (t) => {
  const { normal, paths, env, sentinel, files } = loadMain(t, false);
  assert.equal(paths.userData, normal);
  assert.equal(paths.sessionData, normal);
  assert.equal(env.ARBOR_STATS_PATH, path.join(normal, "statistics.json"));
  for (const file of files)
    assert.deepEqual(fs.readFileSync(path.join(normal, file)), sentinel);
});
