"use strict";
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "sorting does not repeat an unchanged error alert", timeout: 30,
  setup(f) {
    const repo = f.repository("projects/repo");
    const broken = repo.worktree("broken");
    f.write("projects/broken/.git", "gitdir: invalid\n");
    f.preferences();
    return { path: broken.path };
  },
  launches: [async t => {
    await t.settled(); await t.painted();
    await t.click(`${await t.row(t.world.path)} .activity-cell`); await t.press("Delete");
    await t.until(() => t.visible("#error-banner"), "error alert");
    const before = await t.text("#error-message");
    // Observe the live region until the sort button's accessible label
    // changes. Sorting is the real input; the observer only records reads.
    const repeated = t.js(`new Promise(resolve => {
      const message = document.querySelector('#error-message');
      const direction = document.querySelector('#sort-direction');
      const changes = [];
      const errors = new MutationObserver(() => changes.push(message.textContent));
      errors.observe(message, { childList: true, characterData: true, subtree: true });
      const sorted = new MutationObserver(() => {
        requestAnimationFrame(() => {
          errors.disconnect(); sorted.disconnect(); resolve(changes);
        });
      });
      sorted.observe(direction, { attributes: true, attributeFilter: ['aria-label'] });
    })`);
    await t.click("#sort-direction");
    assert.equal(await t.text("#error-message"), before);
    assert.deepEqual(await repeated, [], "unchanged role=alert text should not be republished on sorting");
  }],
});
