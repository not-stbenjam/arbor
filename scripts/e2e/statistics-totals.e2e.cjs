"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, cache } = require("./setup-helpers.cjs");
scenario({ name: "statistics real totals and accessible charts", timeout: 25,
  setup(f) {
    const repo = f.repository("projects/repo", { files: { "payload": 4096 } });
    const trees = [repo.worktree("one").path, repo.worktree("two").path];
    const bytes = trees.reduce((total, folder) => total + ["README.md", ".gitignore", "payload"]
      .reduce((sum, name) => sum + Buffer.byteLength(f.read(`${folder}/${name}`)), 0), 0);
    f.preferences(); return { trees, bytes };
  }, launches: [async (t) => {
    await t.settled();
    await t.click("#statistics-button");
    await t.until(async () => /No cleanups yet/.test(await t.text("#statistics-content")), "empty state");
    assert.equal(t.fixture.statistics(), null);
    await t.click('[aria-label="Close statistics"]');
    const bytes = t.world.bytes;
    assert.equal((await t.state()).report.worktrees.reduce((sum, row) => sum + row.sizeBytes, 0), bytes);
    await t.click("#cleanup-button");
    await open(t, "cleanup-dialog");
    await t.click("#cleanup-confirm");
    await t.until(() => t.world.trees.every((p) => !t.fixture.exists(p)), "both real folders deleted");
    await t.settled();
    const stats = t.fixture.statistics();
    assert.equal(stats.removedWorktrees, 2);
    assert.equal(stats.estimatedBytesReclaimed, bytes);
    assert.equal(stats.cleanupSessions, 1);
    await t.until(() => cache(t).entries.every((e) => e.report.worktrees.length === 0), "cache records deletion");
    await t.menu("File", "Statistics…");
    await t.until(() => t.text('[data-stat="removedWorktrees"]'), "totals visible");
    assert.equal(await t.text('[data-stat="removedWorktrees"]'), "2");
    assert.match((await t.texts(".statistics-metric"))[0], /^1\s+Cleanups$/);
    const plot = '[data-chart="removedWorktrees"]';
    assert.equal(await t.attribute(plot, "role"), "slider");
    await t.click(plot);
    await t.press("End");
    assert.equal(await t.attribute(plot, "aria-valuenow"), "30");
    assert.equal(await t.attribute(plot, "aria-valuetext"), "Today: 2 worktrees deleted");
    await t.press("Home");
    assert.equal(await t.attribute(plot, "aria-valuenow"), "1");
    await t.press("Right");
    assert.equal(await t.attribute(plot, "aria-valuenow"), "2");
    const chosen = await t.text(".statistics-readout");
    await t.hover(`${plot} svg`);
    assert.notEqual(await t.text(".statistics-readout"), chosen);
    assert.equal(await t.attribute(plot, "aria-valuenow"), "2");
    assert.match(await t.text(".statistics-readout"), /: 0$/);
    await t.hover("#statistics-title");
    assert.equal(await t.text(".statistics-readout"), chosen);
    await t.press("End");
    assert.match(await t.text(".statistics-readout"), /Today: 2/);
    await t.press("Escape");
    assert.ok(t.fixture.cliCalls().some((args) => args[0] === "stats"));
    assert.deepEqual(t.fixture.connections(), []);
  }],
});
