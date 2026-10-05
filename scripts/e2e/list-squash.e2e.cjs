"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone } = require("./list-helpers.cjs");

scenario({
  name: "list squash merge evidence",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const tree = record(repo.worktree("squashed", { commits: 1, merged: "squash" }));
    // Only GitHub metadata is simulated. The squash, inspection and deletion
    // use real Git. Fetch stays off; gh never leaves the fixture.
    repo.git("remote", "set-url", "origin", "https://github.com/fixture/arbor.git");
    f.write("pulls.json", JSON.stringify([{ number: 17, html_url: "https://github.com/fixture/arbor/pull/17", title: "Squashed work", state: "closed", merged_at: "2026-01-01T00:00:00Z", head: { sha: tree.head, ref: tree.branch, repo: { full_name: "fixture/arbor" } }, base: { ref: "main", repo: { full_name: "fixture/arbor" } } }]));
    f.tool("gh", `case "$*" in *'/commits/'*) cat '${f.path("pulls.json")}';; *) printf '%s\\n' '{"default_branch":"main"}';; esac`);
    f.preferences();
    return tree;
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("offline ancestry withholds a squash until exact PR evidence is enabled", async () => {
      const row = await t.row(t.world.path);
      assert.equal(await t.exists(`${row} .worktree-state`), false);
      assert.equal(await t.text("#recommended-count"), "0");
      assert.equal(t.fixture.exists(t.world.path), true);
      await t.click("#settings-button");
      await t.click("#scan-github");
      await t.click("#settings-save");
      await t.until(async () => await t.text(`${row} .worktree-state`) === "Merged", "verified squash recommendation");
      await t.settled();
      assert.match(await t.attribute(`${row} .worktree-state`, "title"), /GitHub PR #17 merged this exact commit into main/);
      assert.equal(await t.text("#recommended-count"), "1");
      await t.click("#cleanup-button");
      assert.equal(await t.text(".cleanup-reason"), "GitHub PR #17 merged this exact commit into main");
      await t.click("#cleanup-confirm");
      await gone(t, t.world);
      assert.equal(t.fixture.statistics().removedWorktrees, 1);
      assert.deepEqual(t.messages, []);
    });
  }],
});
