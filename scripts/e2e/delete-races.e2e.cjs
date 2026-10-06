"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, registered } = require("./list-helpers.cjs");

scenario({
  name: "delete refuses changed targets",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = [repo.worktree("branch-changed"), repo.worktree("missing", { missing: true }), repo.worktree("nested-race", { untracked: true })].map(record);
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    const [branch, missing, nested] = t.world;
    await t.step("same commit on a different branch is not the checkout shown", async () => {
      t.fixture.git(branch.path, "switch", "-q", "-c", "replacement");
      t.answer(1);
      await t.click(`${await t.row(branch.path)} [data-delete]`);
      await t.until(() => t.visible("#error-banner"), "stale branch refusal");
      await t.settled();
      assert.match(await t.text("#error-message"), /branch changed/);
      assert.equal(t.fixture.exists(branch.path), true);
      assert.equal(registered(t, branch.repository, branch.path), true);
      assert.match(await t.text(await t.row(branch.path)), /replacement/);
      await t.click("#dismiss-error");
    });
    await t.step("a folder appearing at a missing registration is kept", async () => {
      t.fixture.write(`${missing.path}/irreplaceable.txt`, "new unrelated folder");
      t.answer(1);
      await t.click(`${await t.row(missing.path)} [data-delete]`);
      await t.until(() => t.visible("#error-banner"), "new folder refusal");
      await t.settled();
      assert.match(await t.text("#error-message"), /appeared|verified/);
      assert.equal(t.fixture.read(`${missing.path}/irreplaceable.txt`), "new unrelated folder");
      assert.equal(registered(t, missing.repository, missing.path), true);
      assert.equal(await t.text(`${await t.row(missing.path)} .worktree-state`), "Worktree path could not be verified");
      // The enabled Delete button on this blocked row is reproduced separately
      // in bugs/blocked-delete-enabled.e2e.cjs.
      await t.click("#dismiss-error");
    });
    await t.step("consent to discard files does not authorize a repository added during the question", async () => {
      let inner;
      t.answer(() => {
        inner = t.fixture.repository(`${nested.path}/inner`, { remote: false });
        return 1;
      });
      await t.click(`${await t.row(nested.path)} [data-delete]`);
      await t.until(() => t.visible("#error-banner"), "new repository refusal");
      await t.settled();
      assert.match(await t.text("#error-message"), /now also holds.*repository.*which you were not asked about/);
      assert.equal(t.fixture.git(inner.path, "rev-parse", "HEAD"), inner.head());
      assert.equal(t.fixture.read(`${nested.path}/notes.txt`), "not added\n");
      assert.equal(await t.text(`${await t.row(nested.path)} .worktree-state`), "Nested repository");
      assert.equal(t.fixture.statistics(), null);
    });
  }],
});
