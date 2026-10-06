"use strict";
const { scenario, assert } = require("./harness.cjs");
const { accessible, tabTo, focus, open, close, media, ring, contrast } = require("./stress-helpers.cjs");
scenario({
  name: "accessible states themes and media", timeout: 30,
  setup(f) {
    const r = f.repository("projects/repo");
    r.worktree("merged"); r.worktree("dirty", { modified: true }); r.worktree("locked", { locked: true });
    f.preferences();
  },
  launches: [async t => {
    await t.settled();
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await t.click("#theme-button");
      await t.step(`${theme}: names, selection, expanded state, dialogs and focus rings`, async () => {
        const nodes = await accessible(t);
        const rows = (await t.state()).report.worktrees;
        for (const row of rows) {
          const name = row.path.split("/").pop();
          const matching = nodes.filter((node) => !node.ignored && node.role?.value === "row" && node.description?.value === row.path);
          assert.equal(matching.length, 1, "the full path describes one row");
          const ax = matching[0];
          assert.ok(ax.name.value.startsWith(`${name}, `));
          assert.ok(ax.name.value.includes(`branch ${row.branch} in ${row.repo}`));
          assert.doesNotMatch(ax.name.value, /Select |Delete |Actions for |\/projects\//);
          for (const [role, action] of [["checkbox", "Select"], ["button", "Delete"], ["button", "Actions for"]]) {
            const control = nodes.find((node) => !node.ignored && node.role?.value === role && (node.name?.value === `${action} ${name}` || node.name?.value === `${action} ${name}, which is not a clean delete`));
            assert.ok(control, `${action} ${name} has its own name`);
            assert.ok(!control.name.value.includes(row.path));
          }
          if (name === "merged")
            assert.equal(ax.name.value, "merged, Merged, branch merged in repo, 3 days ago, 27 B");
        }
        await tabTo(t, "#worktree-grid"); await t.press("End"); await ring(t);
        const activeID = await t.attribute("#worktree-grid", "aria-activedescendant");
        const active = await t.evaluate((id) => {
          const row = document.getElementById(id);
          return { name: row.getAttribute("aria-label"), path: row.getAttribute("aria-description") };
        }, activeID);
        const focusedTree = await accessible(t);
        const grid = focusedTree.find((node) => node.role?.value === "treegrid");
        const referenced = grid.properties.find((property) => property.name === "activedescendant").value.relatedNodes[0];
        const focusedRow = focusedTree.find((node) => node.backendDOMNodeId === referenced.backendDOMNodeId);
        assert.equal(focusedRow.name.value, active.name);
        assert.equal(focusedRow.description.value, active.path);
        if (theme === "light") await t.screenshot("5-accessible-row");
        await t.press("Space"); await focus(t, "#worktree-grid");
        assert.equal(await t.js("document.querySelector('.is-current').getAttribute('aria-selected')"), "true");
        assert.equal(await t.js("document.querySelector('.is-current input').checked"), true);
        await t.press("Space");
        assert.equal(await t.js("document.querySelector('.is-current').getAttribute('aria-selected')"), "false");
        await tabTo(t, "[data-toggle-directory]"); await t.press("Left");
        assert.equal(await t.attribute(":focus", "aria-expanded"), "false");
        await t.press("Right"); assert.equal(await t.attribute(":focus", "aria-expanded"), "true");
        for (const [b,d] of [["#settings-button","#settings-dialog"],["#add-host","#machine-dialog"],["#statistics-button","#statistics-dialog"],["#cleanup-button","#cleanup-dialog"]]) {
          await open(t,b,d,true); await accessible(t); await close(t,b,d);
        }
        const readings = await contrast(t);
        console.log(`CONTRAST ${theme} ${JSON.stringify(readings.filter(r => r.ratio < r.minimum))}`);
        assert.deepEqual(readings.filter(r => !r.disabled && r.ratio < r.minimum), [], "enabled text meets AA");
      });
    }
    await t.step("reduced motion suppresses transitions; forced colors keep a focus indicator", async () => {
      await media(t, [{ name: "prefers-reduced-motion", value: "reduce" }]);
      assert.equal(await t.js("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
      assert.deepEqual(await t.js("[...document.querySelectorAll('*')].filter(e=>e.checkVisibility()).filter(e=>{const s=getComputedStyle(e); return s.animationName!=='none'||s.transitionDuration.split(',').some(v=>parseFloat(v)>0)}).map(e=>e.id||e.className)"), []);
      await media(t, [{ name: "forced-colors", value: "active" }]);
      assert.equal(await t.js("matchMedia('(forced-colors: active)').matches"), true);
      await tabTo(t, "#worktree-grid"); await ring(t);
      await accessible(t);
      await media(t, []);
    });
  }],
});
