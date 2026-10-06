const { scenario, assert } = require('./harness.cjs');
const { select, saved } = require('./setup-helpers.cjs');
const { layout } = require('./stress-helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');
async function shot(t, name) {
  const file = await t.screenshot(name);
  const destination = '/tmp/arbor-r8-shots/window';
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(file, path.join(destination, path.basename(file)));
}
const width = t => t.js("document.querySelector('#workspace-sidebar').getBoundingClientRect().width");
async function edgeKey(t, key) { await t.click('#sidebar-resizer'); await t.press(key); }
scenario({
  name: 'window controls and remembered sidebar', timeout: 120,
  setup(f) {
    f.repository('projects/repo', { hoursOld: 300 }).worktree('topic');
    const host = f.host('build'); f.repository(host.relative('projects/remote')).worktree('remote-topic');
    f.preferences({ hosts: [{ host: 'build', name: 'Build', root: host.root }], theme: 'system' });
  },
  launches: [async (t) => {
    await t.settled();
    await t.step('System switches to the opposite displayed theme; Settings retains all three', async () => {
      t.page.debugger.attach('1.3');
      for (const dark of [true, false]) {
        await t.click('#settings-button'); await select(t, '#theme-select', 0); await t.press('Escape');
        if (await t.js("document.querySelector('#settings-dialog').open")) await t.press('Escape');
        await t.page.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
        await t.until(async () => (await t.attribute('#theme-button', 'title')) === `Switch to ${dark ? 'light' : 'dark'} mode`, 'theme follows system');
        await t.click('#theme-button');
        assert.equal(await t.attribute('html', 'data-theme'), dark ? 'light' : 'dark');
      }
      await t.page.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); t.page.debugger.detach();
      await t.click('#theme-button'); assert.equal(await t.attribute('html', 'data-theme'), 'light');
    });
    await t.step('dropdown names, checkmark, keyboard and mouse switch only the host filter', async () => {
      const before = t.fixture.cliCalls().length;
      await t.click('#machine-button');
      assert.deepEqual(await t.texts('#host-menu [role="menuitemradio"]'), ['All hosts', 'This computer', 'Build']);
      assert.equal(await t.attribute('#host-menu [data-all-hosts]', 'aria-checked'), 'true');
      await t.click('#machine-button');
      assert.equal(await t.visible('#host-menu'), false, 'the same button closes its dropdown');
      await t.click('#machine-button');
      await t.press('ArrowDown'); await t.press('Enter');
      await t.until(async () => (await t.state()).hostFilter === '', 'keyboard local choice');
      assert.equal(await t.visible('#path-location'), true);
      await t.click('#machine-button'); await t.click('#host-menu [data-host="build"]');
      await t.until(async () => (await t.state()).hostFilter === 'build', 'mouse SSH choice');
      await t.click('#machine-button'); await t.press('Home'); await t.press('Enter');
      await t.until(async () => (await t.state()).hostFilter === null, 'all hosts');
      assert.equal(await t.visible('#path-location'), false);
      assert.doesNotMatch(await t.text('.pathbar'), /Folders on all hosts/);
      assert.equal(t.fixture.cliCalls().length, before);
      await t.click('#machine-button'); await t.press('End'); await t.press('Enter');
      await t.fill('[data-host-name="build"]', 'Builder'); await t.press('Tab');
      await t.until(() => saved(t).hosts[0].name === 'Builder', 'renamed host');
      await t.press('Escape');
    });
    await t.step('drag, limits, double-click reset and keyboard separator', async () => {
      await t.resize(1240, 800);
      const p = await t.point('#sidebar-resizer');
      await t.drag(p, { x: 300, y: p.y }); assert.equal(await width(t), 300);
      await t.click('#sidebar-resizer', { count: 2 }); assert.equal(await width(t), 208);
      await edgeKey(t, 'ArrowRight'); assert.equal(await width(t), 216);
      await edgeKey(t, 'Home'); assert.equal(await width(t), 160);
      assert.equal(await t.attribute('#sidebar-resizer', 'aria-valuenow'), '160');
      await edgeKey(t, 'End'); assert.equal(await width(t), 320);
      assert.equal(await t.attribute('#sidebar-resizer', 'aria-valuemax'), '320');
    });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await t.click('#theme-button');
      for (const w of [1240, 850]) {
        await t.resize(w, 800); await t.click('#sidebar-resizer', { count: 2 });
        await shot(t, `all-hosts-${theme}-${w}`);
        await t.hover('#theme-button'); await shot(t, `theme-toggle-${theme}-${w}`);
        await t.click('#settings-button'); await shot(t, `dialog-${theme}-${w}`);
        await t.click({ x: 2, y: 2 });
        await t.until(() => t.js("!document.querySelector('#settings-dialog').open"), 'outside closes settings');
        await t.click('#machine-button'); await shot(t, `hosts-${theme}-${w}`); await t.press('Escape');
        for (const state of ['resting', 'hover', 'focused', 'active']) {
          if (state === 'hover') await t.hover('#tree-sort');
          if (state === 'focused') { await t.click('#sort-direction'); await t.press('Shift+Tab'); }
          if (state === 'active') await select(t, '#age-filter', 1);
          const boxes = await t.js(`[...document.querySelectorAll('#tree-sort,#state-filter,#age-filter')].map(e=>{const s=getComputedStyle(e);return [s.borderStyle,s.borderWidth,s.borderColor]})`);
          assert.ok(boxes.every(b => b[0] === 'solid' && b[1] === '1px' && b[2] !== 'rgba(0, 0, 0, 0)'));
          await shot(t, `filters-${state}-${theme}-${w}`);
        }
        await select(t, '#age-filter', 0);
        for (const [id, tabs] of [['tree-sort', -1], ['state-filter', 1], ['age-filter', 2]]) {
          await t.hover(`#${id}`); await shot(t, `filters-${id}-hover-${theme}-${w}`);
          await t.click('#sort-direction');
          await t.press(tabs < 0 ? 'Shift+Tab' : 'Tab', { times: Math.abs(tabs) });
          assert.equal(await t.js(`document.activeElement.id`), id);
          await shot(t, `filters-${id}-focus-${theme}-${w}`);
        }
        for (const [key, name] of [['Home', 'narrow'], ['End', 'wide']]) {
          await edgeKey(t, key); await shot(t, `sidebar-${name}-${theme}-${w}`);
          assert.deepEqual(await layout(t), []);
        }
        await t.click('#sidebar-toggle'); assert.equal(await t.visible('#workspace-sidebar'), false);
        assert.equal(await t.js("getComputedStyle(document.body).getPropertyValue('--sidebar-width').trim()"), '0px');
        await shot(t, `sidebar-hidden-${theme}-${w}`);
        await t.menu('File', 'Settings…'); await t.press('Escape');
        await t.menu('View', 'Toggle Sidebar'); assert.equal(await t.visible('#workspace-sidebar'), true);
        await t.press('Control+b'); await t.until(async () => !(await t.visible('#workspace-sidebar')), 'shortcut hides');
        await t.click('#sidebar-toggle'); assert.equal(await t.visible('#workspace-sidebar'), true);
        await t.click('#sidebar-resizer', { count: 2 });
        await t.zoom(1.5); assert.deepEqual(await layout(t), []); await t.zoom(1);
      }
    }
    await t.resize(1240, 800); await edgeKey(t, 'End'); await t.press('ArrowLeft');
    await t.click('#sidebar-toggle');
    await t.until(() => saved(t).sidebarWidth === 312 && saved(t).sidebarHidden, 'saved sidebar');
    // Make the saved list two hours old for the review pictures on restart.
    const file = t.fixture.path('user-data/workspace-cache.json');
    const cache = JSON.parse(fs.readFileSync(file));
    for (const entry of cache.entries) entry.report.scannedAt = new Date(Date.now() - 7200000).toISOString();
    fs.writeFileSync(file, JSON.stringify(cache));
  }, async (t) => {
    await t.settled();
    assert.equal(await t.visible('#workspace-sidebar'), false);
    await t.click('#sidebar-toggle'); assert.equal(await width(t), 312);
    await t.click('#sidebar-resizer', { count: 2 });
    await t.until(() => t.visible('#stale-note'), 'oldest saved scan');
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await t.click('#theme-button');
      for (const w of [1240, 850]) { await t.resize(w, 800); await shot(t, `stale-${theme}-${w}`); }
    }
    await t.click('#stale-refresh'); await t.settled();
    await t.until(async () => !(await t.visible('#stale-note')), 'refreshed');
    await t.until(() => saved(t).sidebarWidth === null && !saved(t).sidebarHidden, 'reset and visible state saved');
  }, async (t) => {
    await t.settled();
    assert.equal(await t.visible('#workspace-sidebar'), true);
    assert.equal(await width(t), 208, 'reset restores the responsive default after restart');
  }],
});
