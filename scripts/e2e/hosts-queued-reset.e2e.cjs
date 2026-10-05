"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, saved, cache, scans } = require("./setup-helpers.cjs");
scenario({ name: "queued hosts stop all and reset during scans", timeout: 25,
  setup(f) {
    const hosts = ["queue-one", "queue-two", "queue-three", "queue-four"].map((name) => {
      f.host(name).delay(4);
      return { host: name, name, root: "~/projects" };
    });
    const tree = f.repository("projects/repo").worktree("local-safe").path;
    f.preferences({ hosts }); return { tree };
  }, launches: [async (t) => {
    await t.until(async () => (await t.text("#host-progress-list")).includes("Waiting to scan"), "four hosts exceed three scan slots");
    assert.equal(await t.visible("#stop-scan"), true);
    await t.until(async () => (await t.rows()).some((r) => r.text.includes("local-safe")), "local result usable with slow hosts queued");
    await t.click("#stop-scan", { count: 2 });
    await t.until(async () => !(await t.state()).hosts.some((h) => h.busy), "Stop all settles active and queued hosts");
    assert.ok(t.fixture.exists(t.world.tree));
    assert.ok(t.fixture.connections().every((h) => saved(t).hosts.some((entry) => entry.host === h)));
    await t.click("#refresh-button");
    await t.until(() => t.visible('[data-stop-host="queue-one"]'), "refresh restarts stopped host");
    await t.click("#settings-button");
    await open(t, "settings-dialog");
    assert.equal(await t.enabled("#reset-preferences"), true);
    t.answer("Reset Arbor");
    await t.click("#reset-preferences");
    await open(t, "setup-dialog");
    assert.equal(saved(t).setupCompleted, false);
    assert.deepEqual(saved(t).hosts, []);
    assert.deepEqual(cache(t).entries, []);
    assert.equal((await t.state()).hosts.length, 1);
    assert.ok(t.fixture.exists(t.world.tree));
    const calls = scans(t).length;
    await t.press("Escape");
    assert.equal(scans(t).length, calls);
    assert.equal(t.fixture.statistics(), null);
  }],
});
