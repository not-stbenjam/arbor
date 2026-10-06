const { scenario, assert } = require('./harness.cjs');
const { open, closed } = require('./setup-helpers.cjs');
async function outside(t, id) {
  return t.evaluate(id => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { x: Math.max(1, Math.floor(r.left - 10)), y: Math.max(1, Math.floor(r.top - 10)) };
  }, id);
}
async function dragOut(t, id) {
  const point = await outside(t, id);
  await t.drag(`#${id} h2`, point);
  assert.equal(await t.js(`document.getElementById('${id}').open`), true, `${id}: selecting text outwards keeps it open`);
}
scenario({
  name: 'outside clicks take each dialogs Escape path',
  setup(f) {
    const repo = f.repository('projects/repo'); const tree = repo.worktree('merged');
    const dirty = repo.worktree('dirty', { modified: true });
    return { tree: tree.path, dirty: dirty.path };
  },
  launches: [async t => {
    await open(t, 'setup-dialog');
    await dragOut(t, 'setup-dialog');
    await t.click(await outside(t, 'setup-dialog'));
    assert.equal(await t.js("document.querySelector('#setup-dialog').open"), true, 'required setup refuses dismissal');
    await t.press('Escape');
    assert.equal(await t.js("document.querySelector('#setup-dialog').open"), true);
    t.fixture.preferences();
  }, async t => {
    await t.settled();
    const entries = [
      ['settings-dialog', () => t.click('#settings-button')],
      ['machine-dialog', () => t.click('#add-host')],
      ['statistics-dialog', () => t.click('#statistics-button')],
      ['restore-dialog', () => t.click('#recently-deleted-button')],
      ['notes-dialog', () => t.menu('Help', 'Keyboard Shortcuts')],
      ['cleanup-dialog', () => t.click('#cleanup-button')],
      ['files-dialog', async () => { await t.contextMenu(`${await t.row(t.world.tree)} .branch-cell`); await t.chooseMenu('Show Files…'); }],
    ];
    for (const [id, show] of entries) await t.step(id, async () => {
      await show(); await open(t, id);
      await dragOut(t, id);
      if (id === 'settings-dialog') await t.fill('#scan-root', '/unsaved');
      await t.press('Escape'); await closed(t, id);
      const escapeFocus = await t.focused();
      await show(); await open(t, id);
      if (id === 'settings-dialog') assert.equal(await t.value('#scan-root'), t.fixture.root);
      await t.click(await outside(t, id)); await closed(t, id);
      assert.equal(await t.focused(), escapeFocus, `${id}: same focus return as Escape`);
      assert.equal(t.fixture.exists(t.world.tree), true, 'cancel never deletes');
    });
    assert.deepEqual((await t.js("[...document.querySelectorAll('dialog')].map(d=>d.id)")).sort(), ['setup-dialog', ...entries.map(([id]) => id)].sort());
    await t.click('#select-all');
    await t.click('#remove-selected'); await open(t, 'cleanup-dialog');
    await t.click('#cleanup-dialog [data-files]'); await open(t, 'files-dialog');
    await t.click(await outside(t, 'files-dialog')); await closed(t, 'files-dialog');
    assert.equal(await t.js("document.querySelector('#cleanup-dialog').open"), true, 'only the top dialog closes');
    await t.click(await outside(t, 'cleanup-dialog')); await closed(t, 'cleanup-dialog');
    assert.equal(t.fixture.exists(t.world.tree), true);
  }],
});
