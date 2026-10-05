"use strict";
const { scenario, assert } = require("./harness.cjs");
const { scans, cached } = require("./setup-helpers.cjs");
scenario({ name: "launch explicit local and SSH paths", timeout: 20,
  setup(f) {
    const h = f.host("launchbox");
    // ~ resolves inside fixture HOME on each machine.
    const local = f.repository("home/projects/repo").worktree("local").path;
    const remote = f.repository(h.relative("projects/repo")).worktree("remote").path;
    return { local, remote };
  }, launches: [{ args: ["--path", "~/projects"], run: async (t) => {
    await t.settled();
    assert.equal(await t.js("document.querySelector('#setup-dialog').open"), false);
    assert.equal(await t.text("#machine-label"), "This computer");
    assert.match(await t.text(await t.row(t.world.local)), /local/);
    assert.deepEqual(t.fixture.connections(), []);
    await cached(t, t.world.local);
    assert.equal(t.fixture.exists("user-data/preferences.json"), false);
  } }, { args: ["--host", "launchbox", "--path", "~/projects"], run: async (t) => {
    await t.settled();
    assert.equal(await t.text("#machine-label"), "launchbox");
    assert.match(await t.text(await t.row(t.world.remote)), /remote/);
    assert.ok(scans(t).some((a) => a.includes("--host") && a.includes("launchbox")));
    assert.ok(t.fixture.connections().every((h) => h === "launchbox"));
    await cached(t, t.world.remote);
    assert.equal(t.fixture.exists("user-data/preferences.json"), false);
    await t.click("#machine-button");
    assert.equal(await t.exists('[data-forget-host="launchbox"]'), false);
  } }],
});
