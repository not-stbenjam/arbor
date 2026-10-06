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
        assert.match(question.detail, /branches and commits are kept/i);
        if (index < 3) {
          assert.equal(question.title, "Not a clean delete");
          assert.match(question.detail, index === 2 ? /ignored files/ : /uncommitted changes and untracked files/);
          assert.match(await t.attribute(`${row} [data-delete]`, "title"), /Not a clean delete/);
        }
        if (["locked", "reason", "missing"].includes(tree.name)) assert.match(question.detail, /locks.*overridden/);
        if (tree.name === "missing") assert.match(question.detail, /Only Git worktree registrations will be removed/);
        if (tree.name === "detached") assert.match(question.detail, /Detached commits will be kept/);
        // A clean worktree that is only locked or detached is not said to
        // hold work: it is asked about by what it is, and still as forced.
        if (["locked", "reason"].includes(tree.name)) {
          assert.equal(question.title, "Delete locked worktree?");
          assert.equal(question.message, `Delete “${tree.name}” and override its lock?`);
          assert.deepEqual(question.buttons, ["Cancel", "Override Lock & Delete"]);
          assert.match(question.detail, /^The last scan found nothing uncommitted in it\. It is deleted whatever it holds now/);
        }
        if (tree.name === "detached") {
          assert.equal(question.title, "Delete detached worktree?");
          assert.deepEqual(question.buttons, ["Cancel", "Delete Worktree"]);
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
