"use strict";
const { scenario, assert } = require("../e2e/harness.cjs");
const { scaleFixture, tabTo, focus } = require("../e2e/stress-helpers.cjs");

scenario({
  name: "filter and sort retain worktree controls", timeout: 120,
  setup: f => scaleFixture(f, 100),
  launches: [async t => {
    await t.settled();
    await t.until(async () => await t.count('.worktree-row') === 100, 'all rows');
    const before = await t.js(`(() => {
      window.perfRows = new Map([...document.querySelectorAll('.worktree-row')].map(row => [row.dataset.id, row]));
      return [...perfRows.values()].map(row => [row.dataset.id, row.textContent]);
    })()`);
    await t.press('/');
    await t.type('delete-000');
    await t.until(async () => await t.count('.worktree-row') === 10, 'ten matches');
    assert.equal(await t.js(`(() => { const row = document.querySelector('.worktree-row'); return perfRows.get(row.dataset.id) === row; })()`), true);
    await t.press('Escape');
    await t.until(async () => await t.count('.worktree-row') === 100, 'filter cleared');
    const retained = () => t.js(`([...document.querySelectorAll('.worktree-row')].every(row => perfRows.get(row.dataset.id) === row))`);
    assert.equal(await retained(), true, 'clearing a filter restores the same controls');
    assert.deepEqual(await t.js(`([...document.querySelectorAll('.worktree-row')].map(row => [row.dataset.id, row.textContent]))`), before);
    await t.click('#sort-direction');
    assert.equal(await retained(), true, 'sorting moves the same controls');
    await tabTo(t, '#worktree-grid');
    await t.press('End');
    await focus(t, '#worktree-grid');
    assert.equal(await t.js(`(() => { const grid = document.querySelector('#worktree-grid'), row = document.getElementById(grid.getAttribute('aria-activedescendant')); return row === document.querySelector('.worktree-row:last-child') && row.classList.contains('is-current'); })()`), true);
    for (const path of t.world.paths) assert.ok(t.fixture.exists(path));
  }],
});
