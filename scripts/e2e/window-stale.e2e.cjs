const { scenario, assert } = require('./harness.cjs');
const fs = require('node:fs');
scenario({
  name: 'the list ages while the window is open',
  setup(f) { f.repository('projects/repo').worktree('topic'); f.preferences(); },
  launches: [
    async (t) => {
      await t.settled();
      assert.equal(await t.visible('#stale-note'), false);
      t.page.debugger.attach('1.3');
      await t.page.debugger.sendCommand('Emulation.setVirtualTimePolicy', {
        policy: 'pause', initialVirtualTime: (Date.now() + 61 * 60000) / 1000,
      });
      t.window.blur(); t.window.focus();
      await t.until(() => t.visible('#stale-note'), 'a live scan is old when the window returns');
      assert.equal(t.fixture.cliCalls().filter(a => a[0] === 'list').length, 1);
      t.page.debugger.detach();
      const file = t.fixture.path('user-data/workspace-cache.json');
      await t.until(() => fs.existsSync(file), 'saved scan');
      const cache = JSON.parse(fs.readFileSync(file));
      for (const e of cache.entries) e.report.scannedAt = new Date(Date.now() - 1800000).toISOString();
      fs.writeFileSync(file, JSON.stringify(cache));
    },
    async (t) => {
      await t.settled();
      assert.equal(await t.visible('#stale-note'), false, 'thirty minutes is fresh');
      t.page.debugger.attach('1.3');
      // Chromium advances both Date and timers. No application code or state
      // is replaced and no focus/redraw event is sent to cause the notice.
      await t.page.debugger.sendCommand('Emulation.setVirtualTimePolicy', {
        policy: 'advance', initialVirtualTime: (Date.now() + 31 * 60000) / 1000, budget: 60001,
      });
      await t.until(() => t.visible('#stale-note'), 'the hour passes with the window open');
      assert.equal(t.fixture.cliCalls().filter(a => a[0] === 'list').length, 1);
      await t.click('#stale-refresh');
      await t.until(async () => {
        await t.page.debugger.sendCommand('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 500 });
        return t.fixture.cliCalls().filter(a => a[0] === 'list').length === 2 && !(await t.state()).busy && !(await t.visible('#scan-progress')) && !(await t.visible('#stale-note'));
      }, 'refresh removes the notice');
      assert.equal(await t.visible('#stale-note'), false);
      t.page.debugger.detach();
    },
  ],
});
