"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone } = require("./list-helpers.cjs");

scenario({
  name: "delete selection across fixture hosts",
  timeout: 30,
  setup(f) {
    const local = record(f.repository("projects/local-repo").worktree("local"));
    const host = f.host("test-host");
    const remote = f.repository(`${host.root}/remote-repo`);
    const trees = [local, record(remote.worktree("remote-dirty", { untracked: true })), record(remote.worktree("remote-missing", { missing: true }))];
    f.preferences({ hosts: [{ host: host.name, name: "Test host", root: host.root }] });
    return { trees, host: host.name };
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("cross-host selection describes hosts and risks before deleting", async () => {
      assert.equal(await t.text("#all-count"), "3");
      await t.click("#select-all");
      assert.equal(await t.text("#selection-label"), "3 worktrees selected · 1 not clean");
      t.answer(0);
      await t.click("#remove-selected");
      await t.until(() => t.messages.length === 1, "cross-host question");
      await t.settled();
      assert.match(t.messages[0].message, /1 of 3 worktrees on 2 hosts is not clean/);
      assert.match(t.messages[0].detail, /This computer: 1.*Test host \[test-host\]: 2/);
      assert.match(t.messages[0].detail, /1 missing worktree registration/);
      assert.equal(t.fixture.read(`${t.world.trees[1].path}/notes.txt`), "not added\n");
      assert.equal(t.fixture.exists(t.world.trees[0].path), true);
      t.answer(1);
      await t.click("#remove-selected");
      for (const tree of t.world.trees) await gone(t, tree);
      assert.match(await t.text("#empty-state"), /No linked worktrees here/);
      assert.equal(t.fixture.statistics().removedWorktrees, 1);
      const remote = t.fixture.cli("stats", "--host", t.world.host, "--json");
      assert.equal(remote.status, 0, remote.stderr);
      assert.equal(JSON.parse(remote.stdout).removedWorktrees, 2);
      assert.equal(JSON.parse(remote.stdout).missingRegistrations, 1);
      await t.click("#statistics-button");
      await t.until(async () => await t.text('[data-stat="removedWorktrees"]') === "3", "combined host statistics");
      assert.ok(t.fixture.connections().every((host) => host === "test-host"));
    });
  }],
});
