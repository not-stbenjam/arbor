"use strict";

// The whole of what Arbor is for, once through: find the worktrees beneath a
// folder, see which are safe to delete and why, delete those, and find the
// rest untouched, on disk and after starting again.

const { scenario, assert } = require("./harness.cjs");

scenario({
  name: "journey",
  setup(fixture) {
    const alpha = fixture.repository("projects/alpha");
    const worktrees = {
      merged: alpha.worktree("merged"),
      shipped: alpha.worktree("shipped", { commits: 2, merged: true, pushed: true }),
      wip: alpha.worktree("wip", { commits: 1, modified: true }),
      scratch: alpha.worktree("scratch", { untracked: true }),
      today: alpha.worktree("today", { hoursOld: 0 }),
    };
    fixture.write("projects/notes.txt", "not a worktree\n");
    fixture.preferences();
    return {
      repository: alpha.path,
      head: alpha.head(),
      paths: Object.fromEntries(Object.entries(worktrees).map(([name, tree]) => [name, tree.path])),
    };
  },
  launches: [
    async (t) => {
      const { paths } = t.world;
      await t.step("the list shows every linked worktree and its state", async () => {
        await t.settled();
        const rows = (await t.rows()).filter((row) => !row.folder);
        assert.deepEqual(rows.map((row) => row.text.split(" ")[0]).sort(), Object.keys(paths).sort());
        const said = (name) => rows.find((row) => row.text.startsWith(name + " ")).text;
        assert.match(said("merged"), /Merged/);
        assert.match(said("wip"), /1 changed file/);
        assert.match(said("today"), /New/);
        assert.equal(await t.text("#recommended-count"), "2");
      });

      await t.step("the review names what would go, and why", async () => {
        assert.match(await t.text("#cleanup-button"), /Delete recommended \(2\)/);
        await t.click("#cleanup-button");
        await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "the review");
        const listed = await t.texts("#cleanup-list .cleanup-item");
        assert.equal(listed.length, 2);
        assert.ok(listed.some((text) => text.includes("merged") && text.includes(paths.merged)));
        assert.ok(listed.every((text) => /commits are in/.test(text)), listed.join("\n"));
        assert.equal(await t.focused(), "button#cleanup-cancel.button");
      });

      await t.step("agreeing deletes exactly those, with Git", async () => {
        await t.click("#cleanup-confirm");
        await t.until(async () => (await t.state()).report?.worktrees.length === 3, "three rows left");
        await t.settled();
        for (const name of ["merged", "shipped"])
          assert.equal(t.fixture.exists(paths[name]), false, `${name} is gone`);
        for (const name of ["wip", "scratch", "today"])
          assert.equal(t.fixture.exists(paths[name]), true, `${name} is kept`);
        assert.equal(t.fixture.read("projects/notes.txt"), "not a worktree\n");
        assert.equal(t.fixture.git(t.world.repository, "rev-parse", "HEAD"), t.fixture.git(t.world.repository, "rev-parse", "main"));
        // The branches stay; only the checkouts went.
        for (const name of ["merged", "shipped"])
          assert.ok(t.fixture.git(t.world.repository, "rev-parse", `refs/heads/${name}`));
        assert.equal(t.fixture.git(t.world.repository, "worktree", "list").split("\n").length, 4);
        const removals = t.fixture.cliCalls().filter((args) => args[0] === "remove");
        assert.equal(removals.length, 2);
        assert.ok(removals.every((args) => args.includes("--recommended-only")));
        assert.deepEqual(t.messages, [], "the review was the only question");
        assert.equal(t.fixture.statistics().removedWorktrees, 2);
      });

      await t.step("a worktree with changes asks before it is deleted, and can be refused", async () => {
        const row = await t.row(paths.wip);
        t.answer(0);
        await t.click(`${row} [data-delete]`);
        await t.until(() => t.messages.length === 1, "the question");
        assert.match(t.messages[0].message + t.messages[0].detail, /wip/);
        await t.settled();
        assert.equal(t.fixture.exists(paths.wip), true);
        assert.match(t.fixture.read("projects/wip/README.md"), /edited, not committed/);
      });
    },
    async (t) => {
      await t.step("starting again shows what is left without being told where to look", async () => {
        await t.settled();
        const rows = (await t.rows()).filter((row) => !row.folder);
        assert.deepEqual(rows.map((row) => row.text.split(" ")[0]).sort(), ["scratch", "today", "wip"]);
        assert.equal(await t.text("#recommended-count"), "0");
      });
    },
  ],
});
