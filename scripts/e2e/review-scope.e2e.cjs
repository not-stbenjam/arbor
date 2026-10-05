"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, search, shown, gone, statistics } = require("./list-helpers.cjs");

scenario({
  name: "review filtered recommendations",
  timeout: 30,
  setup(f) {
    const a = f.repository("projects/alpha"), b = f.repository("projects/beta");
    const trees = [a.worktree("a-ready"), a.worktree("a-wip", { modified: true }), b.worktree("b-ready")].map(record);
    f.preferences();
    return trees;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("review contains precisely two recommendations with names, reasons, paths and sizes", async () => {
      await t.click("#cleanup-button");
      await t.until(() => t.visible("#cleanup-dialog"), "review");
      assert.equal(await t.count(".cleanup-item"), 2);
      assert.deepEqual(await t.texts(".cleanup-name"), ["a-ready", "b-ready"]);
      assert.deepEqual(await t.texts(".cleanup-path"), [t.world[0].path, t.world[2].path]);
      assert.ok((await t.texts(".cleanup-reason")).every((text) => text === "All commits are in origin/main"));
      assert.ok((await t.texts(".cleanup-size")).every((text) => /^\d+(?:\.\d+)? B$/.test(text)));
      assert.match(await t.text("#cleanup-lead"), /branches and commits are kept/);
      assert.equal(await t.focused(), "button#cleanup-cancel.button");
      await t.click("#cleanup-cancel");
      await t.click("#cleanup-button", { count: 2 }); await t.press("Escape");
      assert.equal(await t.visible("#cleanup-dialog"), false);
      await t.click("#cleanup-button"); await t.click('[data-close="cleanup-dialog"]');
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
      assert.equal(t.fixture.statistics(), null);
    });
    await t.step("search narrows cleanup, then a repository view deletes only its recommendation", async () => {
      await search(t, "b-ready"); await shown(t, ["b-ready"]);
      assert.match(await t.text("#cleanup-button"), /Delete recommended \(1\)/);
      await t.click("#cleanup-button");
      assert.deepEqual(await t.texts(".cleanup-name"), ["b-ready"]);
      assert.match(await t.text("#cleanup-total"), /Only what the list is showing/);
      await t.click("#cleanup-confirm"); await gone(t, t.world[2]);
      assert.equal(t.fixture.exists(t.world[0].path), true);
      await search(t, "");
      await t.click("#repo-list .repo-item");
      await t.click("#cleanup-button");
      assert.deepEqual(await t.texts(".cleanup-name"), ["a-ready"]);
      await t.click("#cleanup-confirm"); await gone(t, t.world[0]);
      assert.equal(t.fixture.exists(t.world[1].path), true);
      assert.equal(await t.enabled("#cleanup-button"), false);
      await t.click('[data-view="recommended"]');
      assert.match(await t.text("#empty-state"), /Nothing to clean up/);
      assert.deepEqual(t.messages, []);
      await statistics(t, 2);
    });
  }],
});
