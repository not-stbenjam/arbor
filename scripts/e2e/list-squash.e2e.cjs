"use strict";

const { scenario, assert } = require("./harness.cjs");
const { record, gone } = require("./list-helpers.cjs");

scenario({
  name: "list squash merge evidence",
  timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    // Squashed as it stood: Git itself can match its changes.
    const squashed = record(repo.worktree("squashed", { commits: 2, merged: "squash" }));
    // Squashed with a change made while merging: the default branch has no
    // commit that makes exactly this branch's changes, so only the pull
    // request says it was merged.
    const tree = record(repo.worktree("edited", { commits: 2 }));
    repo.git("merge", "-q", "--squash", "edited");
    f.write("projects/repo/change-3.txt", "reworded while merging\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "edited (squashed, with a change)");
    repo.git("push", "-q", "origin", "main");
    // Only GitHub metadata is simulated. The squash, inspection and deletion
    // use real Git. Fetch stays off; gh never leaves the fixture.
    repo.git("remote", "set-url", "origin", "https://github.com/fixture/arbor.git");
    f.write("pulls.json", JSON.stringify([{ number: 17, html_url: "https://github.com/fixture/arbor/pull/17", title: "Squashed work", state: "closed", merged_at: "2026-01-01T00:00:00Z", head: { sha: tree.head, ref: tree.branch, repo: { full_name: "fixture/arbor" } }, base: { ref: "main", repo: { full_name: "fixture/arbor" } } }]));
    f.tool("gh", `case "$*" in *'/commits/'*) cat '${f.path("pulls.json")}';; *) printf '%s\\n' '{"default_branch":"main"}';; esac`);
    f.preferences();
    return { ...tree, squashed };
  },
  launches: [async (t) => {
    await t.settled();
    await t.step("Git alone finds a squash whose changes it can match", async () => {
      const row = await t.row(t.world.squashed.path);
      assert.equal(await t.text(`${row} .worktree-state`), "Merged");
      assert.match(await t.attribute(`${row} .worktree-state`, "title"), /^All changes are in origin\/main, as one commit \(squashed\)/);
      assert.equal(await t.text("#recommended-count"), "1");
    });
    await t.step("a squash changed while merging is withheld until the pull request says so", async () => {
      const row = await t.row(t.world.path);
      assert.equal(await t.exists(`${row} .worktree-state`), false);
      assert.equal(t.fixture.exists(t.world.path), true);
      await t.click("#settings-button");
      await t.click("#scan-github");
      await t.click("#settings-save");
      await t.until(async () => await t.text(`${row} .worktree-state`) === "Merged", "verified squash recommendation");
      await t.settled();
      assert.match(await t.attribute(`${row} .worktree-state`, "title"), /GitHub PR #17 merged this exact commit into main/);
      assert.equal(await t.text("#recommended-count"), "2");
      await t.click("#cleanup-button");
      assert.deepEqual((await t.texts(".cleanup-reason")).sort(), [
        "All changes are in origin/main, as one commit (squashed)",
        "GitHub PR #17 merged this exact commit into main",
      ]);
      await t.click("#cleanup-confirm");
      await gone(t, t.world);
      await gone(t, t.world.squashed);
      assert.equal(t.fixture.statistics().removedWorktrees, 2);
      assert.deepEqual(t.messages, []);
    });
  }],
});
