"use strict";
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "search result count is announced", timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    repo.worktree("alpha"); repo.worktree("beta"); f.preferences();
  },
  launches: [async t => {
    await t.settled();
    await t.press("/"); await t.type("alpha");
    await t.until(async () => await t.count(".worktree-row") === 1, "one search result");
    // Said once typing pauses, so that each letter is not read out.
    await t.until(() => t.js("/\\b1 worktree matches “alpha”/.test(document.querySelector('#announcement').textContent)"), "the result count is announced");
    await t.press("Control+a"); await t.press("Backspace");
    await t.until(() => t.js("/Filter cleared\\. 2 worktrees shown/.test(document.querySelector('#announcement').textContent)"), "clearing is announced");
  }],
});
