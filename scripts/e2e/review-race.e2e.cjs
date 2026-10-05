"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone, statistics } = require("./list-helpers.cjs");

scenario({
  name: "review rechecks disk before deletion",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = [repo.worktree("a-changes"), repo.worktree("b-commit"), repo.worktree("c-safe")].map(record);
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("the review stays the one read while disk changes", async () => {
      await t.click("#cleanup-button");
      assert.equal(await t.count(".cleanup-item"), 3);
      t.fixture.write(`${t.world[0].path}/late.txt`, "must survive");
      t.fixture.write(`${t.world[1].path}/commit.txt`, "new commit");
      t.fixture.git(t.world[1].path, "add", "commit.txt");
      t.fixture.git(t.world[1].path, "commit", "-q", "-m", "After review");
      assert.deepEqual(await t.texts(".cleanup-name"), ["a-changes", "b-commit", "c-safe"]);
      await t.click("#cleanup-confirm");
      await gone(t, t.world[2]);
      assert.equal(t.fixture.read(`${t.world[0].path}/late.txt`), "must survive");
      assert.equal(t.fixture.read(`${t.world[1].path}/commit.txt`), "new commit");
      assert.match(await t.text("#error-message"), /a-changes.*Uncommitted or untracked files/);
      assert.match(await t.text("#error-message"), /b-commit.*commit.*changed/);
      assert.equal(await t.text("#all-count"), "2");
      assert.equal(await t.text("#recommended-count"), "0");
      assert.deepEqual(t.messages, []);
      await statistics(t, 1);
    });
  }],
});
