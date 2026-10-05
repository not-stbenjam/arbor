"use strict";
const { scenario, assert } = require("./harness.cjs");
const { saved, scans, open, select, noScan, cached } = require("./setup-helpers.cjs");
scenario({
  name: "setup local choices and consent", timeout: 25,
  setup(f) {
    const repo = f.repository("projects/repo");
    return { kept: repo.worktree("kept").path, skipped: repo.worktree("skip-me").path };
  },
  launches: [async (t) => {
    await open(t, "setup-dialog");
    await t.step("Escape cannot bypass setup; chooser cancellation keeps the draft", async () => {
      await t.press("Escape");
      assert.equal(await t.text("#setup-step-label"), "1 of 3");
      await t.fill("#setup-root", t.fixture.root);
      t.choose();
      await t.click("#setup-choose-folder");
      assert.equal(await t.value("#setup-root"), t.fixture.root);
      t.choose(t.fixture.root);
      await t.click("#setup-choose-folder");
      assert.equal(t.choosers.length, 2);
      await t.click("#setup-remote");
      assert.equal(await t.value("#setup-root"), "~");
      assert.equal(await t.visible("#setup-choose-folder"), false);
      await t.fill("#setup-root", "~/projects");
      await t.click("#setup-local");
      assert.equal(await t.value("#setup-root"), t.fixture.root);
      await noScan(t);
    });
    await t.step("options survive Back and review describes the exact consent", async () => {
      await t.click("#setup-next");
      await t.click("#setup-github");
      await t.click("#setup-fetch");
      await t.click("#setup-step-2 summary");
      const defaults = await t.value("#setup-excludes");
      await t.fill("#setup-excludes", "temporary");
      await t.click("#setup-reset-excludes");
      assert.equal(await t.value("#setup-excludes"), defaults);
      await t.fill("#setup-excludes", "skip-me");
      await select(t, "#setup-theme", 2);
      await t.click("#setup-back");
      assert.equal(await t.value("#setup-root"), t.fixture.root);
      await t.click("#setup-next");
      assert.equal(await t.checked("#setup-fetch"), true);
      await t.click("#setup-next");
      assert.equal(await t.text("#setup-review-machine"), "This computer");
      assert.equal(await t.text("#setup-review-root"), t.fixture.root);
      assert.equal(await t.text("#setup-review-github"), "On");
      assert.equal(await t.text("#setup-review-fetch"), "On");
      assert.equal(await t.text("#setup-review-theme"), "Dark");
      assert.equal(await t.attribute("#setup-review-excludes", "title"), "skip-me");
      await noScan(t);
      assert.equal(t.fixture.exists("user-data/preferences.json"), false);
    });
    await t.step("double clicking Start scans once and saves the choices", async () => {
      await t.click("#setup-start", { count: 2 });
      await cached(t, t.world.kept);
      await t.settled();
      await t.until(async () => (await t.rows()).some((r) => r.text.includes("kept")), "scanned list drawn");
      assert.equal((await t.rows()).filter((r) => !r.folder).length, 1);
      assert.match(await t.text(await t.row(t.world.kept)), /kept/);
      assert.ok(t.fixture.exists(t.world.skipped));
      const p = saved(t);
      assert.equal(p.setupCompleted, true);
      assert.equal(p.theme, "dark");
      assert.deepEqual(p.scan, { root: t.fixture.root, host: "", github: true, fetch: true, excludes: ["skip-me"] });
      assert.equal(scans(t).length, 1);
      assert.ok(scans(t)[0].includes("--github") && scans(t)[0].includes("--fetch"));
      await cached(t, t.world.kept);
    });
  }],
});
