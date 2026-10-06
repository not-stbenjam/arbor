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
test('sidebar drag, reset, keyboard, hide, restore and resize persist only user choices', async () => {
  const { createSidebarController } = await import('../renderer/sidebar-controller.mjs');
  const { document, el } = dom();
  const writes = [], window = { innerWidth: 1240, addEventListener(k,fn) { this[k] = fn; }, removeEventListener() {} };
  const controller = createSidebarController({ document, window, api: { saveView: async value => writes.push(value) }, notify() {} });
  const edge = el('#sidebar-resizer'), button = el('#sidebar-toggle');
  const key = key => edge.handlers.keydown({ key, preventDefault() {} });
  assert.equal(edge.attrs['aria-valuenow'], '208');
  edge.handlers.pointerdown({ button: 0, clientX: 208, pointerId: 1, preventDefault() {} });
  edge.handlers.pointermove({ clientX: 900 }); edge.handlers.pointerup();
  assert.equal(writes.at(-1).sidebarWidth, 320);
  edge.handlers.dblclick(); assert.equal(writes.at(-1).sidebarWidth, null);
  key('ArrowLeft'); assert.equal(writes.at(-1).sidebarWidth, 200);
  key('Home'); assert.equal(edge.attrs['aria-valuenow'], '160');
  key('End'); assert.equal(edge.attrs['aria-valuenow'], '320');
  el('#workspace-sidebar').focus(); button.onclick();
  assert.equal(document.activeElement, button);
  assert.equal(document.body.style['--sidebar-width'], '0px');
  assert.equal(writes.at(-1).sidebarHidden, true);
  controller.restore({ sidebarWidth: 272, sidebarHidden: true });
  button.onclick(); assert.equal(edge.attrs['aria-valuenow'], '272');
  const before = writes.length;
  window.innerWidth = 500; window.resize();
  assert.equal(edge.attrs['aria-valuenow'], '220');
  window.innerWidth = 1240; window.resize();
  assert.equal(edge.attrs['aria-valuenow'], '272'); assert.equal(writes.length, before);
  controller.dispose();
});
