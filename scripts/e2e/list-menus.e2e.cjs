"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, selected, gone } = require("./list-helpers.cjs");

scenario({
  name: "list native row actions",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const local = record(repo.worktree("local")), missing = record(repo.worktree("missing", { missing: true }));
    const host = f.host("test-host");
    const remote = record(f.repository(`${host.root}/remote-repo`).worktree("remote"));
    f.preferences({ hosts: [{ host: host.name, name: "Test host", root: host.root }] });
    return { local, missing, remote };
  },
  launches: [async (t) => {
    await t.settled();
    const { local, missing, remote } = t.world;
    const opening = ["Show in file manager", "Open folder", "Open in terminal"];
    await t.step("right-click and ellipsis offer the same actions; opening is recorded", async () => {
      const row = await t.row(local.path);
      await t.click(`${await t.row(remote.path)} .branch-cell`);
      const menu = await t.contextMenu(`${row} .branch-cell`);
      assert.deepEqual(menu.filter((item) => !item.separator).map((item) => item.label), ["Copy path", "Show Files…", ...opening, "Delete “local”…"]);
      assert.ok(menu.every((item) => item.enabled));
      await selected(t, ["remote"]);
      await t.chooseMenu("Copy path");
      assert.equal(t.clipboard(), local.path);
      const beforeEnter = t.native.menus;
      await t.press("Enter");
      await t.until(() => t.native.menus > beforeEnter, "Enter opens the current row's actions");
      await selected(t, ["remote"]);
      for (const label of opening) {
        const before = t.native.menus;
        await t.click(`${row} [data-worktree-menu]`);
        await t.until(() => t.native.menus > before, "ellipsis menu");
        assert.deepEqual(t.native.menu.items.map((item) => item.label), menu.map((item) => item.label));
        await t.chooseMenu(label);
      }
      await t.until(() => t.fixture.opened().length === 1 && t.opened.length === 2, "all opening requests recorded");
      assert.deepEqual(t.opened, [{ how: "showItemInFolder", target: local.path }, { how: "openPath", target: local.path }]);
      assert.ok(t.fixture.opened()[0].includes(local.path));
      assert.equal(t.fixture.exists(local.path), true);
    });
    await t.step("missing and SSH rows disable all opening actions but allow copy and deletion", async () => {
      for (const tree of [missing, remote]) {
        const menu = await t.contextMenu(`${await t.row(tree.path)} .branch-cell`);
        for (const label of opening) assert.equal(menu.find((item) => item.label === label).enabled, false);
        assert.equal(menu.find((item) => item.label === "Copy path").enabled, true);
        assert.equal(menu.find((item) => item.label.startsWith("Delete “")).enabled, true);
        if (tree === remote) assert.equal(menu.find((item) => item.label === "Available on this computer only").enabled, false);
        await t.chooseMenu("Copy path");
        assert.equal(t.clipboard(), tree.path);
      }
    });
    await t.step("menu Delete acts on its row rather than the other selection", async () => {
      await t.contextMenu(`${await t.row(local.path)} .branch-cell`);
      t.answer(1);
      await t.chooseMenu("Delete “local”…");
      await gone(t, local);
      assert.equal(t.fixture.exists(remote.path), true);
      await selected(t, ["remote"]);
      assert.equal(t.fixture.statistics().removedWorktrees, 1);
    });
  }],
});
