"use strict";
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "view-memory",
  setup(fixture) {
    fixture.repository("projects/shop").worktree("agent");
    const host = fixture.host("build");
    fixture.repository(host.relative("projects/shop")).worktree("remote");
    fixture.preferences({ hosts: [{ host: "build", name: "Build", root: host.root }] });
  },
  launches: [
    async (t) => {
      await t.settled();
      await t.click('[data-sort="size"]');
      await t.click("#sort-direction");
      await t.click("#machine-button");
      await t.click('.machine-option[data-host=""]');
      await t.until(() => t.text("#machine-label").then((text) => text === "This computer"), "local view");
      await t.click(".worktree-row .branch-cell");
      await t.fill("#search", "agent");
      await t.until(() => JSON.parse(t.fixture.read("user-data/preferences.json")).sort === "size", "saved view");
    },
    async (t) => {
      await t.settled();
      assert.equal(await t.value("#tree-sort"), "size");
      assert.equal(await t.attribute("#sort-direction", "aria-label"), "Sort ascending; switch direction");
      assert.equal(await t.text("#machine-label"), "This computer");
      assert.equal(await t.value("#search"), "");
      assert.equal(await t.count(".worktree-row.selected"), 0);
      await t.screenshot("1-remembered-view");
      await t.click("#machine-button");
      await t.click("[data-all-hosts]");
      await t.until(() => JSON.parse(t.fixture.read("user-data/preferences.json")).hostFilter === null, "saved all hosts");
    },
    async (t) => {
      await t.settled();
      assert.equal(await t.text("#machine-label"), "All hosts");
      await t.click("#machine-button");
      await t.click('.machine-option[data-host="build"]');
      await t.until(() => JSON.parse(t.fixture.read("user-data/preferences.json")).hostFilter === "build", "saved SSH host");
    },
    async (t) => {
      await t.settled();
      assert.equal(await t.text("#machine-label"), "Build");
      await t.click("#machine-button");
      await t.click("#host-menu [data-manage]");
      await t.click('[data-forget-host="build"]');
      await t.until(() => JSON.parse(t.fixture.read("user-data/preferences.json")).hosts.length === 0, "forgotten host");
    },
    async (t) => {
      await t.settled();
      assert.equal((await t.state()).hostFilter, null);
      assert.equal(await t.count(".worktree-row"), 1);
    },
  ],
});
