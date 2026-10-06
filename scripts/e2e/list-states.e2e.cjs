"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, registered } = require("./list-helpers.cjs");

scenario({
  name: "list states",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/alpha");
    const definitions = {
      merged: {}, shipped: { commits: 1, merged: true, pushed: true },
      squash: { commits: 2, merged: "squash" }, rebased: { commits: 2, merged: "rebase" },
      unpushed: { commits: 1 }, pushed: { commits: 1, pushed: true },
      modified: { modified: true }, untracked: { untracked: true },
      ignored: { ignored: { "local.log": "private configuration" } },
      detached: { detached: true }, locked: { locked: true },
      reason: { locked: "Do not interrupt deployment" }, missing: { missing: true },
      today: { hoursOld: 0 }, outside: { at: "elsewhere/outside" },
    };
    const trees = Object.fromEntries(Object.entries(definitions).map(([name, options]) => [name, record(repo.worktree(name, options))]));
    const local = f.repository("projects/nested/local", { remote: false });
    trees.offline = record(local.worktree("offline"));
    const trunk = f.repository("projects/nested/deeper/trunk-repo", { branch: "release" });
    trees.release = record(trunk.worktree("release-topic"));
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("states, exact tooltips, and recommendation counts", async () => {
      const expected = {
        merged: ["Merged", /All commits are in origin\/main\. Clean/],
        shipped: ["Merged", /its branch is kept/],
        squash: ["Merged", /^Squashed into origin\/main as [0-9a-f]{10}\. Clean/],
        rebased: ["Merged", /^Every commit was copied into origin\/main \(rebased or cherry-picked\)\. Clean/],
        modified: ["1 changed file", /^Uncommitted or untracked files\. Deleting this worktree discards them\.$/],
        untracked: ["1 changed file", /Deleting this worktree discards them/],
        ignored: ["Ignored files", /discards its ignored files, such as local configuration or build output/],
        locked: ["Locked", /^Locked with git worktree lock\.$/],
        reason: ["Locked", /^Do not interrupt deployment$/],
        missing: ["Folder missing", /^The folder is gone\. Deleting removes only its leftover Git registration\.$/],
        today: ["New", /Created in the last 24 hours, and its HEAD has not moved since/],
        offline: ["Merged", /All commits are in main/],
        release: ["Merged", /All commits are in origin\/release/],
      };
      for (const [name, tree] of Object.entries(t.world)) {
        if (name === "outside") continue;
        const row = await t.row(tree.path);
        assert.equal(await t.attribute(`${row} .worktree-path`, "title"), tree.path);
        assert.equal(await t.enabled(`${row} [data-delete]`), true, name);
        if (expected[name]) {
          assert.equal(await t.text(`${row} .worktree-state`), expected[name][0], name);
          assert.match(await t.attribute(`${row} .worktree-state`, "title"), expected[name][1], name);
        } else assert.equal(await t.exists(`${row} .worktree-state`), false, name);
        assert.equal(t.fixture.exists(tree.path), name !== "missing");
        assert.equal(registered(t, tree.repository, tree.path), true);
      }
      assert.match(await t.text(await t.row(t.world.detached.path)), /Detached HEAD/);
      assert.equal(await t.text("#recommended-count"), "6");
      assert.equal(await t.text("#all-count"), "16");
      assert.equal(await t.text("#repo-count"), "3");
      assert.equal((await t.state()).report.worktrees.some((row) => row.path === t.world.outside.path), false);
      assert.equal(t.fixture.exists(t.world.outside.path), true);
      // Publication is not a merge: neither branch is marked Merged.
      assert.equal((await t.worktree(t.world.pushed.path)).published, true);
      assert.equal((await t.worktree(t.world.unpushed.path)).published, false);
    });
    await t.step("Recommended and repository views count only their rows", async () => {
      await t.click('[data-view="recommended"]');
      assert.equal(await t.count(".worktree-row"), 6);
      assert.equal(await t.text("#visible-count"), "6 of 16");
      assert.equal(await t.visible("#recommendation-note"), true);
      const repositories = await t.texts("#repo-list .repo-item");
      assert.ok(repositories.some((text) => /alpha/.test(text) && /14/.test(text)));
      for (const [index, [name, count]] of [["alpha", 14], ["local", 1], ["trunk-repo", 1]].entries()) {
        await t.click(`#repo-list .repo-item:nth-child(${index + 1})`);
        assert.equal(await t.count(".worktree-row"), count);
        assert.ok((await t.text("#view-title")).startsWith(name));
        assert.equal(await t.text("#visible-count"), `${count} of 16`);
      }
      await t.click('[data-view="all"]');
      assert.equal(await t.count(".worktree-row"), 16);
      assert.deepEqual(t.messages, []);
      assert.equal(t.fixture.statistics(), null);
    });
  }],
});
