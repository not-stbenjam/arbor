"use strict";

// On starting again Arbor shows the list it saved, without scanning. When
// that list is over an hour old it says so where the list is, with the
// way to bring it up to date, since what it shows is what Delete acts on.

const fs = require("node:fs");
const { scenario, assert } = require("./harness.cjs");

scenario({
  name: "a saved list over an hour old says so",
  timeout: 40,
  setup(fixture) {
    const repository = fixture.repository("projects/repo");
    repository.worktree("old-one");
    fixture.preferences();
    return { repository: repository.path };
  },
  launches: [
    async (t) => {
      await t.settled();
      assert.equal(await t.visible("#stale-note"), false, "a list just scanned is not stale");
      // The list is saved as it is scanned. Date the saved one two hours back,
      // and add a worktree it does not know about.
      const file = t.fixture.path("user-data/workspace-cache.json");
      await t.until(() => fs.existsSync(file), "the saved list");
      const before = fs.readFileSync(file, "utf8");
      const scanned = before.match(/"scannedAt":\s*"([^"]+)"/)[1];
      const aged = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      fs.writeFileSync(file, before.split(scanned).join(aged));
      t.fixture.gitWith(t.fixture.dated(72), t.world.repository, "worktree", "add", "-q", "-b", "newer", t.fixture.path("projects/newer"), "main");
    },
    async (t) => {
      await t.step("the saved list is shown at once, and says how old it is", async () => {
        await t.until(() => t.visible("#stale-note"), "the notice");
        assert.match(await t.text("#stale-text"), /^Scanned 2h ago\.$/);
        assert.equal((await t.rows()).filter((row) => !row.folder).length, 1, "the list is the saved one");
        assert.equal(t.fixture.cliCalls().filter((args) => args[0] === "list").length, 1, "nothing was scanned on starting");
      });
      await t.step("dismissing it keeps the saved list; it is not scanned behind one's back", async () => {
        await t.click("#stale-dismiss");
        assert.equal(await t.visible("#stale-note"), false);
        assert.equal(await t.focused(), "table#worktree-grid.directory-table");
        assert.equal(t.fixture.cliCalls().filter((args) => args[0] === "list").length, 1);
      });
    },
    async (t) => {
      await t.step("Refresh on the notice scans, and the notice goes", async () => {
        await t.until(() => t.visible("#stale-note"), "the notice again on the next start");
        await t.click("#stale-refresh");
        await t.until(async () => (await t.rows()).filter((row) => !row.folder).length === 2, "the worktree the saved list did not know");
        await t.settled();
        assert.equal(await t.visible("#stale-note"), false);
        assert.match(await t.text("#scan-time"), /Scanned/);
      });
    },
  ],
});
