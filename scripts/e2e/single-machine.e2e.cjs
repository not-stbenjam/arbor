"use strict";
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "single-machine",
  setup(f) {
    f.repository("projects/storefront").worktree("agent-7f3a");
    const host = f.host("build");
    f.repository(host.relative("projects/repo")).worktree("remote");
    f.preferences();
    return { remoteRoot: host.root };
  },
  launches: [async (t) => {
    await t.settled();
    assert.equal(await t.text("#machine-label"), "This computer");
    assert.equal(await t.text("#root-label"), t.fixture.root);
    assert.equal(await t.count(".host-row"), 0);
    assert.equal(await t.attribute(".directory-row", "aria-level"), "1");
    assert.deepEqual(await t.texts(".repo-item > span:nth-child(2)"), ["storefront"]);
    assert.doesNotMatch(await t.attribute("#cleanup-button", "title"), /all hosts/);
    await t.screenshot("4-this-computer");
    await t.click("#cleanup-button");
    assert.match(await t.text("#cleanup-total"), / · This computer$/);
    assert.doesNotMatch(await t.text(".cleanup-context"), /This computer/);
    await t.press("Escape");
    await t.click("#statistics-button");
    await t.until(() => t.exists(".statistics-scope"), "statistics");
    assert.equal(await t.text(".statistics-scope"), "This computer");
    await t.press("Escape");
    await t.click("#path-button");
    assert.equal(t.choosers.length, 1, "the local path opens the folder picker");
    assert.equal(await t.enabled("#machine-button"), false);
    await t.click("#add-host");
    assert.equal(await t.count("[data-all-hosts]"), 0);
    assert.equal(await t.attribute('.machine-option[data-host=""]', "aria-current"), "true");
    await t.fill("#host-input", "build");
    await t.fill("#host-root", t.world.remoteRoot);
    await t.click('#host-form button[type="submit"]');
    await t.settled();
    await t.click("#machine-button");
    await t.click("[data-all-hosts]");
    await t.until(() => t.text("#machine-label").then((label) => label === "All hosts"), "all hosts view");
    assert.equal(await t.visible("#path-location"), false);
    assert.equal(await t.count(".host-row"), 2);
    await t.click("#machine-button");
    await t.click("#host-menu [data-manage]");
    await t.click('[data-forget-host="build"]');
    await t.press("Escape");
    await t.until(() => t.text("#machine-label").then((label) => label === "This computer"), "local wording after forgetting the last host");
    assert.equal(await t.count(".host-row"), 0);
  }],
});
