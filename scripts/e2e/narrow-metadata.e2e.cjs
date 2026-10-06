"use strict";
const { scenario, assert } = require("./harness.cjs");
const { layout } = require("./stress-helpers.cjs");
scenario({
  name: "narrow-metadata",
  setup(f) {
    const repo = f.repository("projects/storefront");
    repo.worktree("agent-7f3a", { branch: "agent/cart-badge" });
    const dirty = repo.worktree("a-long-name-" + "x".repeat(60), { branch: "feature/" + "b".repeat(80), modified: true });
    // A sparse fixture file exercises GB wording without allocating GB on disk.
    const payload = f.write(`${dirty.path}/payload`, "");
    require("node:fs").truncateSync(payload, Math.round(1.2 * 1024 ** 3));
    f.preferences();
  },
  launches: [async (t) => {
    await t.settled();
    await t.resize(850, 560);
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await t.click("#theme-button");
      for (const zoom of [1, 1.5, 2]) {
        await t.zoom(zoom);
        await t.step(`${theme}, 850x560 at ${zoom * 100}% keeps age, size and total`, async () => {
          await t.evaluate(() => document.querySelector(".worktree-row:last-child").scrollIntoView({ block: "end" }));
          assert.deepEqual(await layout(t), []);
          assert.equal(await t.visible("#space-label"), true);
          assert.match(await t.text("#space-label"), / on disk$/);
          const rows = await t.evaluate(() => [...document.querySelectorAll(".worktree-row")].map((row) => {
            const metadata = row.querySelector(".worktree-metrics");
            return {
              compact: metadata.checkVisibility(),
              fits: metadata.scrollWidth <= metadata.clientWidth &&
                metadata.getBoundingClientRect().right <= row.querySelector(".branch-cell").getBoundingClientRect().right,
              age: row.querySelector(".activity-cell").textContent,
              size: row.querySelector(".size-cell").textContent,
              text: metadata.textContent,
              title: row.querySelector(".worktree-context").title,
            };
          }));
          for (const row of rows) {
            assert.equal(row.compact, zoom > 1);
            if (row.compact) assert.equal(row.fits, true, "age and size fit in their cell");
            assert.equal(row.text, ` · ${row.age} · ${row.size}`);
            assert.ok(row.title.endsWith(row.text));
          }
          await t.screenshot(`3-narrow-${theme}-${zoom}`);
        });
      }
      await t.zoom(1);
    }
  }],
});
