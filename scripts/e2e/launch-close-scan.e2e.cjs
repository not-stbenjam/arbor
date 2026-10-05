"use strict";
const { scenario, assert } = require("./harness.cjs");
const { cached, menuRole } = require("./setup-helpers.cjs");
scenario({ name: "close during SSH scan and restart", timeout: 20,
  setup(f) {
    const h = f.host("closingbox");
    const tree = f.repository(h.relative("projects/repo")).worktree("safe").path;
    h.delay(3);
    f.preferences({ hosts: [{ host: h.name, name: h.name, root: "~/projects" }] });
    return { tree };
  }, launches: [async (t) => {
    await t.until(() => t.visible('[data-stop-host="closingbox"]'), "scan in progress");
    await t.until(() => t.fixture.connections().includes("closingbox"), "SSH actually started");
    t.fixture.host("closingbox").delay(0);
    assert.deepEqual(t.messages, []);
    assert.ok(t.fixture.exists(t.world.tree));
    await menuRole(t, "quit");
    await t.until(() => t.window.isDestroyed(), "window closes after scan cancellation");
    assert.deepEqual(t.messages, []);
  }, async (t) => {
    await t.settled();
    assert.match(await t.text(await t.row(t.world.tree)), /safe/);
    assert.ok(t.fixture.exists(t.world.tree));
    await cached(t, t.world.tree);
  }],
});
