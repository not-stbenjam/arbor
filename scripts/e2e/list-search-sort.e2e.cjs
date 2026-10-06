"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, shown, search, selected } = require("./list-helpers.cjs");

scenario({
  name: "list search and sort",
  timeout: 30,
  setup(f) {
    const alpha = f.repository("projects/alpha"), zulu = f.repository("projects/zulu");
    const a = zulu.worktree("a", { branch: "z-topic", hoursOld: 96, files: { "payload": 3000 } });
    const b = alpha.worktree("b", { branch: "a-topic", hoursOld: 48, files: { "payload": 1000 } });
    const c = alpha.worktree("c", { branch: "m-topic", hoursOld: 72, files: { "payload": 2000 } });
    // Git metadata contributes to activity; make the three ages unambiguous.
    for (const [tree, hours] of [[a, 96], [b, 48], [c, 72]]) {
      f.backdate(tree.path, hours);
      f.backdate(f.git(tree.path, "rev-parse", "--absolute-git-dir"), hours);
    }
    f.preferences();
    return [a, b, c].map(record);
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("all five sort keys and their reverse directions", async () => {
      const orders = [["a", "b", "c"], ["b", "c", "a"], ["b", "c", "a"], ["b", "c", "a"], ["a", "c", "b"]];
      for (let index = 0; index < orders.length; index++) {
        await t.click("#tree-sort");
        await t.press("Home");
        await t.press("Down", { times: index });
        await t.press("Enter");
        await shown(t, orders[index]);
        assert.match(await t.attribute("#sort-direction", "title"), index >= 3 ? /^Descending/ : /^Ascending/);
        await t.click("#sort-direction");
        // Repository ties keep their names ascending in either direction.
        await shown(t, index === 2 ? ["a", "b", "c"] : [...orders[index]].reverse());
      }
      await t.click('[data-sort="path"]'); await shown(t, ["a", "b", "c"]);
      await t.click('[data-sort="path"]'); await shown(t, ["c", "b", "a"]);
    });
    await t.step("search name, branch, repository and path; no matches and clear", async () => {
      await t.click(`${await t.row(t.world[0].path)} .branch-cell`);
      // A tick outlasts the search that takes its row out of the list.
      await search(t, "z-topic"); await shown(t, ["a"]); await selected(t, ["a"]);
      await search(t, "ALPHA"); await shown(t, ["c", "b"]);
      assert.equal(await t.text("#selection-label"), "1 worktree selected · 1 not shown");
      await search(t, t.world[1].path); await shown(t, ["b"]);
      await search(t, "projects/c"); await shown(t, ["c"]);
      await search(t, "nothing-matches"); await shown(t, []);
      assert.match(await t.text("#empty-state"), /No worktrees match “nothing-matches”/);
      assert.equal(await t.enabled("#cleanup-button"), false);
      await t.click("[data-clear-filter]"); await shown(t, ["c", "b", "a"]);
      assert.equal(await t.value("#search"), "");
      await t.click('[data-view="recommended"]');
      assert.match(await t.text("#empty-state"), /Nothing to clean up/);
      for (const tree of t.world) assert.equal(t.fixture.exists(tree.path), true);
      assert.equal(t.fixture.statistics(), null);
    });
  }],
});
