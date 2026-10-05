"use strict";
const { scenario, assert } = require("./harness.cjs");
const { focus, tabTo, open, close, ring, menuKey } = require("./stress-helpers.cjs");
scenario({
  name: "keyboard navigation and focus",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const paths = Array.from({ length: 8 }, (_, i) => repo.worktree(`row-${i}`).path);
    f.preferences();
    return { paths };
  },
  launches: [async t => {
    await t.settled();
    await t.step("Tab reaches the tree; arrows, ranges and selection keep visible focus", async () => {
      await tabTo(t, "#worktree-grid");
      await ring(t);
      const current = async () => (await t.rows()).filter(r => !r.folder).findIndex(r => r.current);
      for (const [key, index] of [["End",7],["Home",0],["Down",1],["Up",0]]) {
        await t.press(key); await focus(t, "#worktree-grid"); assert.equal(await current(), index);
      }
      await t.press("Space"); await focus(t, "#worktree-grid");
      assert.equal((await t.rows()).filter(r => r.ticked && !r.folder).length, 1);
      await t.press("Shift+Down"); await focus(t, "#worktree-grid");
      assert.equal((await t.rows()).filter(r => r.ticked && !r.folder).length, 2);
      await t.press("Control+a"); await focus(t, "#worktree-grid");
      assert.equal((await t.rows()).filter(r => r.ticked && !r.folder).length, 8);
      await t.press("Escape"); await focus(t, "#worktree-grid");
      assert.equal((await t.rows()).filter(r => r.ticked).length, 0);
    });
    await t.step("Enter and both menu keys address the current row", async () => {
      for (const key of ["Enter", "Shift+F10", "ContextMenu"]) {
        const before = t.native.menus;
        if (key === "ContextMenu") await menuKey(t); else await t.press(key);
        await t.until(() => t.native.menus > before, key);
        await focus(t, "#worktree-grid");
        assert.ok(t.native.menu.items.some(i => i.label === "Copy path"));
      }
    });
    await t.step("Delete and Backspace can be cancelled without losing the row", async () => {
      for (const key of ["Delete", "Backspace"]) {
        const before = t.messages.length;
        t.answer("Cancel"); await t.press(key);
        await t.until(() => t.messages.length > before, "native confirmation");
        await t.settled(); await focus(t, "#worktree-grid");
      }
      for (const p of t.world.paths) assert.ok(t.fixture.exists(p));
    });
    await t.step("search, sorting, sidebar and every non-destructive dialog are keyboard reachable", async () => {
      await t.press("/"); await focus(t, "#search");
      await t.type("row-7"); await focus(t, "#search");
      assert.equal((await t.rows()).filter(r => !r.folder).length, 1);
      await t.press("Escape"); await focus(t, "#search");
      assert.equal(await t.value("#search"), "");
      await tabTo(t, "#tree-sort"); await t.press("End"); await focus(t, "#tree-sort");
      assert.equal(await t.value("#tree-sort"), "size");
      await tabTo(t, "#sort-direction"); await t.press("Enter"); await focus(t, "#sort-direction");
      await tabTo(t, '[data-view="recommended"]'); await t.press("Enter");
      await focus(t, '[data-view="recommended"]');
      for (const [button, dialog] of [["#settings-button","#settings-dialog"],["#statistics-button","#statistics-dialog"],["#machine-button","#machine-dialog"],["#cleanup-button","#cleanup-dialog"]]) {
        await open(t, button, dialog, true); await close(t, button, dialog);
      }
    });
  }],
});
