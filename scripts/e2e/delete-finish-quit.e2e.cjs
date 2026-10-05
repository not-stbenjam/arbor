"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gate, release, closeWindow, shown, registered } = require("./list-helpers.cjs");

scenario({
  name: "finish current deletion and quit",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = ["a", "b", "c"].map((name) => record(repo.worktree(name)));
    f.preferences();
    gate(f, " worktree remove ");
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.click("#select-all");
    t.answer(1);
    await t.click("#remove-selected");
    await t.until(() => t.fixture.exists("gate-entered"), "first Git deletion held");
    await t.until(() => t.visible(".host-progress-bar"), "deletion progress");
    t.answer(async (question) => {
      assert.equal(question.message, "Finish the current worktree, then quit?");
      assert.match(question.detail, /remaining worktrees untouched/);
      t.fixture.write("quit-question-seen", question.message);
      await release(t);
      return 1;
    });
    closeWindow(t);
    // A real app exit ends this launch. The next launch verifies that exit
    // happened only after one completed removal, with the remainder intact.
    await new Promise(() => {});
  }, async (t) => {
    await t.settled();
    await t.step("reopening proves only the current worktree finished", async () => {
      assert.equal(t.fixture.read("quit-question-seen"), "Finish the current worktree, then quit?");
      await shown(t, ["b", "c"]);
      assert.equal(t.fixture.exists(t.world[0].path), false);
      assert.equal(registered(t, t.world[0].repository, t.world[0].path), false);
      for (const tree of t.world.slice(1)) {
        assert.equal(t.fixture.exists(tree.path), true);
        assert.equal(registered(t, tree.repository, tree.path), true);
      }
      assert.equal(t.fixture.statistics().removedWorktrees, 1);
      assert.equal(t.fixture.cliCalls().filter((args) => args[0] === "remove").length, 1);
    });
  }],
});
