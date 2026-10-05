"use strict";
const { scenario, assert } = require("./harness.cjs");
const { saved, scans, select, cached } = require("./setup-helpers.cjs");
scenario({ name: "theme and cached restart", timeout: 20,
  setup(f) { const tree = f.repository("projects/repo").worktree("cached").path; f.preferences(); return { tree }; },
  launches: [async (t) => {
    await t.settled();
    for (const theme of ["dark", "system", "light"]) {
      await t.click("#theme-button");
      assert.equal(await t.attribute("html", "data-theme"), theme);
      await t.until(() => saved(t).theme === theme, "appearance saved");
      assert.match(await t.attribute("#theme-button", "title"), new RegExp(theme));
      if (theme !== "system")
        assert.equal(await t.js("getComputedStyle(document.body).backgroundColor"),
          theme === "dark" ? "rgb(32, 33, 36)" : "rgb(255, 255, 255)");
    }
    await t.click("#settings-button");
    await select(t, "#theme-select", 2);
    await t.until(() => saved(t).theme === "dark", "Settings appearance saved immediately");
    await t.press("Escape");
    assert.equal(await t.attribute("html", "data-theme"), "dark");
    await cached(t, t.world.tree);
    t.fixture.write("scan-count", String(scans(t).length));
  }, async (t) => {
    await t.settled();
    assert.equal(await t.attribute("html", "data-theme"), "dark");
    assert.equal(await t.js("getComputedStyle(document.body).backgroundColor"), "rgb(32, 33, 36)");
    assert.match(await t.text("#scan-time"), /Saved results/);
    assert.equal(scans(t).length, Number(t.fixture.read("scan-count")));
    assert.match(await t.text(await t.row(t.world.tree)), /cached/);
    await t.click("#refresh-button");
    await t.until(() => scans(t).length > Number(t.fixture.read("scan-count")), "explicit refresh runs");
    await t.settled();
    await t.until(async () => /^Scanned/.test(await t.text("#scan-time")), "refreshed timestamp drawn");
  }],
});
