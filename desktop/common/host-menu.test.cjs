const test = require('node:test');
const assert = require('node:assert/strict');
function dom() {
  const elements = new Map();
  const document = { activeElement: null, querySelector(s) {
    if (!elements.has(s)) elements.set(s, { attrs: {}, style: { setProperty(k,v) { this[k] = v; } }, handlers: {},
      setAttribute(k,v) { this.attrs[k] = String(v); },
      addEventListener(k,fn) { this.handlers[k] = fn; },
      focus() { document.activeElement = this; }, contains(e) { return e === this; },
      setPointerCapture() {},
    });
    return elements.get(s);
  } };
  document.body = document.querySelector('body');
  return { document, el: document.querySelector.bind(document) };
}
test('host menu marks the scope, moves keyboard focus and chooses without scanning', async () => {
  const { createHostMenu } = await import('../renderer/host-menu.mjs');
  const { document, el } = dom();
  const button = el('#machine-button'), menu = el('#host-menu');
  const items = [el('all'), el('local'), el('remote'), el('manage')];
  let open = false, chosen, managed = 0;
  button.getBoundingClientRect = () => ({ left: 8, bottom: 48, width: 192 });
  menu.matches = () => open; menu.showPopover = () => { open = true; }; menu.hidePopover = () => { open = false; };
  menu.querySelectorAll = () => items; menu.querySelector = () => items[1];
  createHostMenu({ document, choices: () => [{ host: null, name: 'All hosts' }, { host: '', name: 'This computer' }, { host: 'ssh', name: '<Build>' }], selected: () => '', choose: host => { chosen = host; }, manage: () => managed++ });
  button.onclick(); assert.equal(open, true); assert.equal(button.attrs['aria-expanded'], 'true');
  assert.match(menu.innerHTML, /data-host=""[^>]*aria-checked="true"/); assert.match(menu.innerHTML, /&lt;Build&gt;/);
  assert.equal(document.activeElement, items[1]);
  menu.handlers.keydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(document.activeElement, items[2]);
  menu.handlers.keydown({ key: 'End', preventDefault() {} }); assert.equal(document.activeElement, items[3]);
  menu.handlers.keydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(document.activeElement, items[0]);
  menu.handlers.click({ target: { closest: () => ({ dataset: { choice: '0' }, hasAttribute: () => false }) } });
  assert.equal(chosen, null); assert.equal(open, false); assert.equal(document.activeElement, button);
  button.onclick(); menu.handlers.keydown({ key: 'Escape', preventDefault() {} }); assert.equal(open, false);
  button.onclick(); menu.handlers.click({ target: { closest: () => ({ hasAttribute: () => true }) } }); assert.equal(managed, 1);
});
