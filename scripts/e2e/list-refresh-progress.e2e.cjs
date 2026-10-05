"use strict";

const fs = require("node:fs");
const { scenario, assert } = require("./harness.cjs");
const { record, shown, gate } = require("./list-helpers.cjs");

scenario({
  name: "refresh disk and stop scan",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = [repo.worktree("dirty-later"), repo.worktree("removed-later")].map(record);
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    const [dirty, removed] = t.world;
    await t.step("Refresh discovers additions, removals and new changes", async () => {
      t.fixture.write(`${dirty.path}/README.md`, "changed behind Arbor");
      t.fixture.git(removed.repository, "worktree", "remove", removed.path);
      t.fixture.gitWith(t.fixture.dated(72), dirty.repository, "worktree", "add", "-q", "-b", "newly-found", t.fixture.path("projects/newly-found"));
      await t.click("#refresh-button");
      await shown(t, ["dirty-later", "newly-found"]);
      await t.settled();
      assert.equal(await t.text(`${await t.row(dirty.path)} .worktree-state`), "1 changed file");
      assert.equal(await t.text("#all-count"), "2");
      assert.equal(await t.text("#recommended-count"), "1");
      assert.equal(t.fixture.exists(removed.path), false);
      assert.equal(t.fixture.read(`${dirty.path}/README.md`), "changed behind Arbor");
    });
    await t.step("Stop settles a real inspection and preserves checked rows; Refresh resumes", async () => {
      gate(t.fixture, " status ");
      await t.click("#refresh-button");
      await t.until(() => t.fixture.exists("gate-entered"), "Git inspection held");
      await t.until(() => t.visible('[data-stop-host=""]'), "host Stop control");
      assert.match(await t.text("#host-progress-list"), /Checking worktrees/);
      assert.equal(await t.count(".worktree-row"), 2);
      await t.click('[data-stop-host=""]');
      await t.until(async () => !(await t.state()).busy && /Scan stopped/.test(await t.text("#host-progress-list")), "stopped scan notice");
      assert.match(await t.text("#host-progress-list"), /last completed scan/);
      assert.equal(t.fixture.read(`${dirty.path}/README.md`), "changed behind Arbor");
      fs.unlinkSync(t.fixture.path("bin/git"));
      await t.click("#refresh-button");
      await t.settled();
      assert.equal(await t.visible("#scan-progress"), false);
      assert.equal(await t.count(".worktree-row"), 2);
      assert.equal(t.fixture.statistics(), null);
    });
  }],
});
