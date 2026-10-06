"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone, registered, statistics } = require("./list-helpers.cjs");

scenario({
  name: "delete individual unsafe rows",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = [
      repo.worktree("modified", { modified: true }),
      repo.worktree("untracked", { untracked: true }),
      repo.worktree("ignored", { ignored: { "private.log": "secret" } }),
      repo.worktree("locked", { locked: true }),
      repo.worktree("reason", { locked: "Deployment running" }),
      repo.worktree("missing", { missing: true, locked: "Archive" }),
      repo.worktree("detached", { detached: true, commits: 1 }),
    ].map(record);
    const detached = trees.at(-1);
    detached.head = f.git(detached.path, "rev-parse", "HEAD");
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    for (const [index, tree] of t.world.entries()) {
      await t.step(`${tree.name}: refuse, then agree to exactly the displayed risk`, async () => {
        const row = await t.row(tree.path);
        const before = t.messages.length;
        t.answer(0);
        await t.click(`${row} [data-delete]`);
        await t.until(() => t.messages.length === before + 1, "native deletion question");
        await t.settled();
        const question = t.messages.at(-1);
        assert.match(question.message, new RegExp(tree.name));
        // One on no branch has no branch to be told is kept.
        assert.match(question.detail, tree.name === "detached" ? /Its commits are kept/ : /branch and commits are kept/i);
        if (index < 3) {
          assert.equal(question.title, "Delete worktree?");
          assert.match(question.message, index === 2 ? /ignored files/ : /uncommitted changes/);
          assert.match(await t.attribute(`${row} [data-delete]`, "title"), /Discards/);
        }
        if (["locked", "reason", "missing"].includes(tree.name)) assert.match(question.detail, /Lock overridden/);
        if (tree.name === "missing") assert.match(question.detail, /Folder already gone; only registration removed/);
        // A clean worktree that is only locked or detached is not said to
        // hold work: it is asked about by what it is, and still as forced.
        if (["locked", "reason"].includes(tree.name)) {
          assert.equal(question.title, "Delete worktree?");
          assert.equal(question.message, `Delete “${tree.name}”?`);
          assert.deepEqual(question.buttons, ["Cancel", "Delete"]);
          assert.doesNotMatch(question.detail, /discard/i);
        }
        if (tree.name === "detached") {
          assert.equal(question.title, "Delete worktree?");
          assert.deepEqual(question.buttons, ["Cancel", "Delete"]);
        }
        assert.equal(t.fixture.exists(tree.path), tree.name !== "missing");
        assert.equal(registered(t, tree.repository, tree.path), true);
        if (tree.name === "modified") assert.match(t.fixture.read(`${tree.path}/README.md`), /edited, not committed/);
        if (tree.name === "untracked") assert.equal(t.fixture.read(`${tree.path}/notes.txt`), "not added\n");
        if (tree.name === "ignored") assert.equal(t.fixture.read(`${tree.path}/private.log`), "secret");
        t.answer(1);
        await t.click(`${row} [data-delete]`);
        await gone(t, tree);
        await t.click('#toast-region button[aria-label="Dismiss notification"]');
        if (tree.name === "detached") {
          const retained = t.fixture.git(tree.repository, "for-each-ref", "--contains", tree.head, "--format=%(refname)", "refs/heads/arbor/retained/");
          assert.match(retained, /^refs\/heads\/arbor\/retained\//);
        }
      });
    }
    await t.step("all rows gone, primary kept, statistics include missing and retained commits", async () => {
      assert.match(await t.text("#empty-state"), /No linked worktrees here/);
      assert.equal(await t.text("#all-count"), "0");
      assert.equal(await t.enabled("#cleanup-button"), false);
      assert.equal(t.fixture.exists(t.world[0].repository), true);
      assert.equal(t.fixture.statistics().missingRegistrations, 1);
      assert.equal(t.fixture.statistics().detachedCommitsRetained, 1);
      await statistics(t, 7);
    });
  }],
});
