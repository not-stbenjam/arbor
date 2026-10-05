"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, saved, cached } = require("./setup-helpers.cjs");
scenario({ name: "SSH missing folder is a path error and recovers", timeout: 20,
  setup(f) {
    const h = f.host("pathbox");
    const tree = f.repository(h.relative("projects/repo")).worktree("remote-safe").path;
    f.preferences(); return { tree };
  }, launches: [async (t) => {
    await t.settled();
    await t.menu("File", "Add SSH Host…");
    await open(t, "machine-dialog");
    await t.fill("#host-input", "pathbox");
    await t.fill("#host-root", "~/absent");
    await t.click("#host-form button[type=submit]");
    await t.until(() => t.visible("#error-banner"), "remote folder error");
    assert.match(await t.text("#error-message"), /absent/);
    assert.doesNotMatch(await t.text("#error-message"), /SSH key|online and reachable|Could not connect/);
    assert.ok(t.fixture.exists(t.world.tree));
    await t.click("#settings-button");
    await t.fill("#scan-root", "~/projects");
    await t.click("#settings-save");
    await cached(t, t.world.tree);
    await t.until(async () => (await t.rows()).some((r) => r.text.includes("remote-safe")), "correct folder shown");
    assert.equal(saved(t).hosts[0].root, "~/projects");
    assert.equal(await t.visible("#error-banner"), false);
    assert.ok(t.fixture.connections().every((h) => h === "pathbox"));
  }],
});
