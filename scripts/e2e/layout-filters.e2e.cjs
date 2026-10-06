"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { scenario, assert } = require("./harness.cjs");
const { select } = require("./setup-helpers.cjs");
const { layout } = require("./stress-helpers.cjs");

async function choose(t, id, value) {
  const index = await t.evaluate((id, value) => [...document.querySelector(id).options].findIndex(o => o.value === value), id, value);
  assert.ok(index >= 0, `${id} offers ${value}`);
  await select(t, id, index);
  assert.equal(await t.value(id), value);
}

scenario({
  name: "filter bar layout", timeout: 60,
  setup(f) {
    const r = f.repository("projects/repo", { hoursOld: 24000 });
    r.worktree("old-build", { hoursOld: 1000, ignored: { "build.log": "output" } });
    f.backdate(f.path("projects/old-build"), 1000);
    r.worktree("merged", { hoursOld: 1000 });
    f.preferences();
  },
  launches: [async t => {
    await t.settled();
    await choose(t, "#state-filter", "Ignored files");
    await choose(t, "#age-filter", "30");
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await t.click("#theme-button");
      for (const [width, height, zoom] of [[1240, 800, 1], [850, 560, 1], [850, 560, 1.5], [850, 560, 2]]) {
        await t.zoom(1); await t.resize(width, height); await t.zoom(zoom);
        await t.step(`${theme} ${width}x${height} zoom ${zoom}`, async () => {
          assert.deepEqual(await layout(t), [], "filter bar geometry");
          if (zoom <= 1.5) {
            const file = await t.screenshot(`filters-${theme}-${width}-${zoom}`);
            fs.mkdirSync("/tmp/arbor-r6-shots/filters", { recursive: true });
            fs.copyFileSync(file, `/tmp/arbor-r6-shots/filters/${path.basename(file)}`);
          }
        });
      }
      await t.zoom(1);
    }
  }],
});
