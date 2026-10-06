const test = require('node:test');
const assert = require('node:assert/strict');
test('sidebar width uses bounded saved sizes and responsive defaults without losing the preference', async () => {
  const { sidebarWidth, sidebarLayout } = await import('./sidebar-layout.mjs');
  assert.equal(sidebarWidth(null), null);
  assert.equal(sidebarWidth('250'), null);
  assert.equal(sidebarWidth(Infinity), null);
  assert.equal(sidebarWidth(1), 160);
  assert.equal(sidebarWidth(900), 320);
  assert.equal(sidebarWidth(240.7), 241);
  assert.equal(sidebarLayout(null, false, 1240).width, 208);
  assert.equal(sidebarLayout(null, false, 850).width, 185);
  assert.equal(sidebarLayout(320, false, 566).width, 286);
  assert.equal(sidebarLayout(320, false, 1240).width, 320);
  assert.equal(sidebarLayout(240, true, 850).width, 0);
});
