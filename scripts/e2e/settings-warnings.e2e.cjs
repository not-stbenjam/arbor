"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, closed, cache } = require("./setup-helpers.cjs");
scenario({ name: "scan warning notes and recovery", timeout: 20,
  setup(f) {
    const repo = f.repository("projects/repo");
    const tree = repo.worktree("safe").path;
    // An unfetched upstream is real Git metadata with insufficient merge evidence.
    repo.git("remote", "add", "upstream", repo.origin);
    f.preferences(); return { tree, repo: repo.path };
  }, launches: [async (t) => {
    await t.settled();
    assert.equal(await t.visible("#warning-button"), true);
    await t.click("#warning-button");
    await open(t, "notes-dialog");
    assert.match(await t.text("#notes-content"), /upstream/);
    assert.match(await t.text("#notes-content"), /fetch/i);
    assert.ok(cache(t).entries.some((e) => e.report.warnings.some((w) => /upstream/.test(w))));
    await t.click('[aria-label="Close scan warnings"]');
    await closed(t, "notes-dialog");
    await t.click("#settings-button");
    await t.click("#scan-fetch");
    await t.click("#settings-save");
    await t.settled();
    assert.equal(await t.visible("#warning-button"), false);
    assert.match(await t.text(await t.row(t.world.tree)), /Merged/);
    assert.ok(t.fixture.git(t.world.repo, "rev-parse", "refs/remotes/upstream/main"));
  }],
});
