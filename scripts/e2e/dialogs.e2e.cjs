"use strict";
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "concise deletion dialogs",
  size: [1240, 850],
  setup(f) {
    const repo = f.repository("projects/repo");
    const trees = {
      ignored: repo.worktree("old-build", { ignored: { "build.log": "build output" } }),
      changed: repo.worktree("changed", { modified: true }),
      both: repo.worktree("both", { modified: true, ignored: { "build.log": "output" } }),
      nested: repo.worktree("nested"),
      locked: repo.worktree("locked", { locked: true }),
      missing: repo.worktree("missing", { missing: true }),
    };
    f.repository("projects/nested/inside", { remote: false });
    const host = f.host("build-host");
    const remote = f.repository(host.relative("projects", "repo"));
    trees.remote = remote.worktree("remote", { ignored: { "build.log": "output" } });
    f.preferences({ hosts: [{ host: host.name, name: host.name, root: host.root }] });
    return Object.fromEntries(Object.entries(trees).map(([key, row]) => [key, row.path]));
  },
  launches: [async (t) => {
    await t.settled();
    const target = await t.row(t.world.ignored);
    await t.step("ordinary confirmation is exact and under the word budget", async () => {
      t.answer(0);
      await t.click(`${target} [data-delete]`);
      await t.until(() => t.messages.length === 1, "question");
      await t.settled();
      const box = t.messages[0];
      assert.equal(box.message, "Delete “old-build” and its ignored files?");
      assert.equal(box.detail, `Its branch and commits are kept.\n\n${t.world.ignored}`);
      assert.deepEqual(box.buttons, ["Cancel", "Delete", "Show Files…"]);
      const words = `${box.message} ${box.detail.replace(t.world.ignored, "")}`.trim().split(/\s+/).length;
      assert.equal(words, 12);
      assert.ok(words <= 25);
    });
    await t.step("state control and keyboard menu open files without selecting", async () => {
      assert.equal(await t.attribute(`${target} [data-show-files]`, "tabindex"), "-1");
      assert.match(await t.attribute(`${target} [data-show-files]`, "title"), /^Show Files:/);
      await t.click(`${target} [data-show-files]`);
      await t.until(() => t.js("document.querySelector('#files-dialog').open"), "files open");
      assert.equal(await t.attribute(target, "aria-selected"), "false");
      assert.equal(await t.visible("#files-delete"), false);
      await t.click("#files-close");
      // Clicking its control leaves the row unticked; Escape focuses the grid,
      // whose active descendant is then reached with arrows.
      await t.click("#search");
      await t.type("old-build");
      await t.press("ArrowDown");
      await t.press("Enter");
      await t.chooseMenu("Show Files…");
      await t.until(() => t.js("document.querySelector('#files-dialog').open"), "keyboard files");
      assert.equal(await t.attribute(target, "aria-selected"), "false");
      await t.click("#files-close");
      await t.click("#search");
      await t.press("Control+a");
      await t.press("Backspace");
    });
    await t.step("grave losses, remote host, lock and missing folder remain explicit", async () => {
      for (const [kind, expected] of [["nested", /Permanently loses:\n• nested repository, including history kept nowhere else/], ["locked", /Lock overridden\./], ["missing", /Folder already gone; only registration removed\./], ["remote", /On build-host\./]]) {
        const before = t.messages.length;
        t.answer(0);
        await t.click(`${await t.row(t.world[kind])} [data-delete]`);
        await t.until(() => t.messages.length > before, kind);
        await t.settled();
        assert.match(t.messages.at(-1).detail, expected);
      }
    });
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await t.click("#theme-button");
      for (const width of [1240, 850]) {
        await t.resize(width, 850);
        await t.screenshot(`rows-${theme}-${width}`);
        for (const kind of ["ignored", "changed", "both", "nested", "locked"])
          await t.click(`${await t.row(t.world[kind])} [data-select]`);
        await t.click("#remove-selected");
        await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "review");
        assert.equal(await t.text("#cleanup-lead"), "Parent repository branches are kept; permanent losses are listed below.");
        assert.match(await t.text(".cleanup-grave"), /nested repository/);
        await t.screenshot(`review-${theme}-${width}`);
        await t.click("#cleanup-cancel");
        for (const kind of ["ignored", "changed", "both", "nested", "locked"])
          await t.click(`${await t.row(t.world[kind])} [data-select]`);
        t.answer(2);
        await t.click(`${target} [data-delete]`);
        await t.until(() => t.js("document.querySelector('#files-dialog').open"), "files from consent");
        await t.until(async () => (await t.text("#files-total")) !== "", "inventory");
        assert.equal(t.fixture.exists(t.world.ignored), true);
        assert.equal(await t.visible("#files-delete"), true);
        assert.match(await t.text("#files-content"), /build.log/);
        await t.screenshot(`files-${theme}-${width}`);
        await t.click("#files-close");
      }
    }
    await t.step("Show Files cancels deletion; Delete returns to native consent and then deletes", async () => {
      t.answer(2);
      await t.click(`${target} [data-delete]`);
      await t.until(() => t.js("document.querySelector('#files-dialog').open"), "files");
      assert.equal(t.fixture.exists(t.world.ignored), true);
      const before = t.messages.length;
      t.answer(1);
      await t.click("#files-delete");
      await t.until(() => t.messages.length > before, "second confirmation");
      assert.equal(t.messages.at(-1).message, t.messages[0].message);
      await t.until(() => !t.fixture.exists(t.world.ignored), "deleted after consent");
      await t.settled();
      const removals = t.fixture.cliCalls().filter((args) => args[0] === "remove");
      assert.equal(removals.length, 1, "all Show Files and Cancel answers delete nothing");
    });
  }],
});
