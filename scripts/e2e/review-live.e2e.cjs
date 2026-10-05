"use strict";

// A review is of the list as it stood when it was opened. A host still being
// scanned can answer while the review is up, and what it then says about a
// row in the review must be believed: the row is kept, and nothing the
// review never showed is added to what agreeing deletes.

const { scenario, assert } = require("./harness.cjs");
const { record, gone } = require("./list-helpers.cjs");

scenario({
  name: "review keeps rows that change while it is open",
  timeout: 40,
  setup(f) {
    const local = f.repository("projects/repo");
    const host = f.host("slow");
    const remote = f.repository(host.relative("projects/far"));
    const trees = [remote.worktree("a-changed"), local.worktree("b-safe"), remote.worktree("c-later", { modified: true })].map(record);
    f.preferences({ hosts: [{ host: "slow", name: "slow", root: "~/projects" }] });
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("a scan that lands during the review marks changed rows Kept and adds none", async () => {
      assert.match(await t.text("#cleanup-button"), /Delete recommended \(2\)/);
      // The host takes a while to answer the next scan, and by then one of
      // its worktrees has gained a file and another has lost its changes.
      t.fixture.host("slow").delay(2);
      t.fixture.write(`${t.world[0].path}/late.txt`, "keep this");
      t.fixture.git(t.world[2].path, "restore", "README.md");
      await t.click("#refresh-button");
      await t.until(async () => {
        const hosts = (await t.state()).hosts;
        return hosts.find((host) => host.host === "slow")?.busy && !hosts.find((host) => !host.host).busy;
      }, "this computer scanned, the host still being scanned");
      await t.click("#cleanup-button");
      assert.deepEqual(await t.texts(".cleanup-name"), ["b-safe", "a-changed"]);
      assert.equal(await t.exists(".cleanup-item.changed"), false);
      await t.until(async () => /Changed since/.test(await t.text(".cleanup-item.changed") || ""), "the review marks the row the host now says has changed");
      assert.deepEqual(await t.texts(".cleanup-name"), ["b-safe", "a-changed"]);
      assert.match(await t.text(".cleanup-item.changed"), /Kept/);
      assert.equal(await t.text("#cleanup-confirm"), "Delete 1 worktree");
      t.fixture.host("slow").delay(0);
      await t.settled();
      await t.click("#cleanup-confirm");
      await gone(t, t.world[1]);
      assert.equal(t.fixture.read(`${t.world[0].path}/late.txt`), "keep this");
      assert.equal(t.fixture.exists(t.world[2].path), true);
      assert.equal(t.fixture.statistics().removedWorktrees, 1);
    });
  }],
});
