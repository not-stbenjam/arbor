"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, noScan, saved, cached } = require("./setup-helpers.cjs");
scenario({ name: "setup SSH validation and consent", timeout: 20,
  setup(f) { const h = f.host("firstbox"); return { tree: f.repository(h.relative("projects/repo")).worktree("remote").path }; },
  launches: [async (t) => {
    await open(t, "setup-dialog");
    await t.click("#setup-remote");
    for (const host of ["-oProxyCommand", "two words"]) {
      await t.fill("#setup-host", host);
      await t.click("#setup-next");
      assert.equal(await t.text("#setup-step-label"), "1 of 3");
      assert.match(await t.text("#setup-error"), /without spaces or command options/);
      await noScan(t);
    }
    await t.fill("#setup-host", "firstbox");
    await t.fill("#setup-root", "~/projects");
    assert.match(await t.text("#setup-root-help"), /SSH host.*user's home/);
    await t.click("#setup-next");
    await t.click("#setup-next");
    assert.equal(await t.text("#setup-review-machine"), "firstbox");
    assert.equal(await t.text("#setup-review-root"), "~/projects");
    await noScan(t);
    await t.click("#setup-start");
    await cached(t, t.world.tree);
    await t.settled();
    await t.until(async () => (await t.rows()).some((r) => r.text.includes("remote")), "remote row drawn");
    assert.match(await t.text(await t.row(t.world.tree)), /remote/);
    assert.equal(saved(t).scan.host, "firstbox");
    assert.equal(saved(t).hosts[0].root, "~/projects");
    assert.ok(t.fixture.connections().every((h) => h === "firstbox"));
    await cached(t, t.world.tree);
  }],
});
