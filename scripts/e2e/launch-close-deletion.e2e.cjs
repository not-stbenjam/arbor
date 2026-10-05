"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, machine } = require("./setup-helpers.cjs");
scenario({ name: "close during deletion asks and can keep open", timeout: 25,
  setup(f) {
    const h = f.host("deletebox");
    const tree = f.repository(h.relative("projects/repo")).worktree("deleting").path;
    f.preferences({ hosts: [{ host: h.name, name: h.name, root: "~/projects" }] });
    return { tree };
  }, launches: [async (t) => {
    await t.settled();
    await machine(t, "deletebox");
    t.fixture.host("deletebox").delay(0.4);
    await t.click("#cleanup-button");
    await open(t, "cleanup-dialog");
    await t.click("#cleanup-confirm");
    await t.until(() => t.fixture.cliCalls().some((a) => a[0] === "remove"), "real removal process running");
    t.answer("Keep Arbor Open");
    t.window.close();
    await t.until(() => t.messages.length === 1, "quit asks during deletion");
    assert.match(t.messages[0].message, /Finish the current worktree, then quit/);
    assert.match(t.messages[0].detail, /leave the remaining worktrees untouched/);
    assert.equal(t.window.isDestroyed(), false);
    await t.until(() => !t.fixture.exists(t.world.tree), "approved worktree finishes deletion");
    await t.settled();
    assert.equal(t.window.isDestroyed(), false);
    assert.equal(JSON.parse(t.fixture.read("hosts/deletebox/.config/arbor/statistics.json")).removedWorktrees, 1);
  }],
});
