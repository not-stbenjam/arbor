"use strict";

// A long deletion can be stopped from the window. The worktree it is on is
// finished, since half of one is worse than either; the rest are left as
// they were, and that is said rather than reported as a failure.

const { scenario, assert } = require("./harness.cjs");

scenario({
  name: "a deletion stops after the worktree it is on",
  timeout: 60,
  setup(fixture) {
    const repository = fixture.repository("projects/repo");
    const paths = [];
    for (let index = 0; index < 24; index++)
      paths.push(repository.worktree(`done-${String(index).padStart(2, "0")}`).path);
    fixture.preferences();
    return { paths, repository: repository.path };
  },
  launches: [
    async (t) => {
      const { paths } = t.world;
      await t.settled();
      await t.step("Stop is offered while deleting, and ends it between worktrees", async () => {
        await t.click("#cleanup-button");
        await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "the review");
        await t.click("#cleanup-confirm");
        await t.until(() => t.visible("[data-stop-removal]"), "Stop beside the deletion's progress");
        assert.equal(await t.text("[data-stop-removal]"), "Stop");
        await t.click("[data-stop-removal]");
        await t.settled();
        const left = paths.filter((folder) => t.fixture.exists(folder));
        assert.ok(left.length > 0 && left.length < paths.length, `${left.length} of ${paths.length} left`);
        assert.match(await t.text("#toast-region"), new RegExp(`Deleted ${paths.length - left.length} worktrees?.* · Stopped with ${left.length} left alone\\.`));
        assert.equal(await t.visible("#error-banner"), false, "stopping is not an error");
      });
      await t.step("what was left is whole, and still there to delete", async () => {
        const left = paths.filter((folder) => t.fixture.exists(folder));
        const listed = t.fixture.git(t.world.repository, "worktree", "list", "--porcelain");
        for (const folder of paths)
          assert.equal(listed.includes(`worktree ${folder}\n`), left.includes(folder), folder);
        for (const folder of left) assert.equal(t.fixture.exists(`${folder}/README.md`), true);
        assert.equal((await t.rows()).filter((row) => !row.folder).length, left.length);
        assert.match(await t.text("#cleanup-button"), new RegExp(`Delete recommended \\(${left.length}\\)`));
        assert.equal(t.fixture.statistics().removedWorktrees, paths.length - left.length);
        assert.equal(await t.exists("[data-stop-removal]"), false);
      });
    },
  ],
});
