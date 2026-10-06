"use strict";

// What a deletion is agreed to is what its question named. A file made after
// the list was read was not named, so the worktree is left alone, its row is
// looked at again, and the next question names what is there now.

const { scenario, assert } = require("./harness.cjs");

scenario({
  name: "a deletion discards only what its question named",
  size: [1240, 800],
  setup(fixture) {
    const repository = fixture.repository("projects/repo");
    const late = repository.worktree("late", {
      ignored: { "build.log": "build output" },
    });
    const held = repository.worktree("held", { locked: true });
    fixture.preferences();
    return { late: late.path, held: held.path };
  },
  launches: [
    async (t) => {
      await t.settled();
      const refusal =
        /: Not deleted\. It now also holds uncommitted changes and untracked files, which you were not asked about\. Nothing in it was touched; its row now shows what it holds\.$/;
      // Asks to delete one row and agrees; returns the question.
      const agree = async (folder) => {
        const before = t.messages.length;
        t.answer(1);
        await t.click(`${await t.row(folder)} [data-delete]`);
        await t.until(() => t.messages.length === before + 1, "the question");
        return t.messages.at(-1);
      };
      await t.step("a file made since the list was read stops the deletion", async () => {
        t.fixture.write(`${t.world.late}/notes.txt`, "written since\n");
        const question = await agree(t.world.late);
        assert.equal(question.message, "Delete “late” and its ignored files?");
        await t.until(async () => refusal.test((await t.text("#error-message")) || ""), "the refusal");
        await t.settled();
        for (const name of ["notes.txt", "build.log"])
          assert.equal(t.fixture.exists(`${t.world.late}/${name}`), true, `${name} is still there`);
        await t.until(
          async () => /1 changed file/.test(await t.text(await t.row(t.world.late))),
          "the row looked at again",
        );
      });
      await t.step("asked about what is there now, it is deleted", async () => {
        const question = await agree(t.world.late);
        assert.equal(question.message, "Delete “late” and its uncommitted changes and ignored files?");
        await t.until(() => !t.fixture.exists(t.world.late), "deleted");
        await t.settled();
      });
      await t.step("a worktree with nothing to lose is not deleted with a file nobody saw", async () => {
        t.fixture.write(`${t.world.held}/scratch.txt`, "written since\n");
        const question = await agree(t.world.held);
        assert.equal(question.message, "Delete “held”?");
        // (The folder this scenario works in has the word in its name.)
        assert.doesNotMatch(question.detail.replace(t.world.held, ""), /discard/i);
        assert.match(question.detail, /Lock overridden\./);
        await t.until(async () => refusal.test((await t.text("#error-message")) || ""), "the refusal");
        await t.settled();
        assert.equal(t.fixture.exists(`${t.world.held}/scratch.txt`), true);
        const removals = t.fixture.cliCalls().filter((args) => args[0] === "remove");
        assert.ok(
          removals.every((args) => args.includes("--only-acknowledged")),
          "every deletion that discards says that what it names is all it may discard",
        );
      });
    },
  ],
});
