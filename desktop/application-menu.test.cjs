const test = require('node:test');
const assert = require('node:assert/strict');
const { installApplicationMenu, setMenuAvailability, COMMANDS } = require('./application-menu.cjs');
test('View exposes the sidebar shortcut and honors window availability', () => {
  let template, invoked;
  const Menu = {
    buildFromTemplate(value) { template = value; return value; },
    setApplicationMenu() {},
    getApplicationMenu() { return { getMenuItemById(id) { return template.flatMap(m => m.submenu || []).find(i => i.id === id); } }; },
  };
  installApplicationMenu({ app: { name: 'Arbor', isPackaged: true }, Menu, shell: {}, sendAction: value => { invoked = value; } });
  const item = template.find(m => m.label === 'View').submenu.find(i => i.id === 'toggle-sidebar');
  assert.equal(item.accelerator, 'CmdOrCtrl+B');
  assert.ok(COMMANDS.includes('toggle-sidebar'));
  item.click(); assert.equal(invoked, 'toggle-sidebar');
  setMenuAvailability(Menu, {}); assert.equal(item.enabled, false);
  setMenuAvailability(Menu, { 'toggle-sidebar': true }); assert.equal(item.enabled, true);
});
