"use strict";
const { scenario, assert } = require("../harness.cjs");
const { open, machine } = require("../setup-helpers.cjs");
scenario({ name: "menu refresh disabled during real deletion", timeout: 20,
  setup(f) {
    const h = f.host("menubox");
    f.repository(h.relative("projects/repo")).worktree("deleting");
    f.preferences({ hosts: [{ host: h.name, name: h.name, root: "~/projects" }] });
  }, launches: [async (t) => {
    await t.settled();
    await machine(t, "menubox");
    t.fixture.host("menubox").delay(0.5);
    await t.click("#cleanup-button");
    await open(t, "cleanup-dialog");
    await t.click("#cleanup-confirm");
    await t.until(() => t.fixture.cliCalls().some((args) => args[0] === "remove"), "real removal started");
    const refresh = t.menuItems().find((item) => item.path.join("/") === "File/Refresh Worktrees");
    const enabled = refresh.enabled;
    // Settle the fixture deletion even though the later assertion fails.
    await t.until(async () => !(await t.state()).removing, "cleanup finishes");
    assert.equal(enabled, false, "Refresh must be disabled while cleanup runs");
  }],
});
