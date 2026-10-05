"use strict";
const { scenario, assert } = require("../harness.cjs");
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
    await t.painted();
    const announcements = await t.js("[...document.querySelectorAll('[aria-live], [role=status]')].map(e=>e.textContent.trim()).filter(Boolean)");
    assert.ok(announcements.some(s => /\b1 (?:matching )?(?:worktree|result|match)\b/i.test(s)),
      `announce the filtered result count; live regions contain ${JSON.stringify(announcements)}`);
  }],
});
