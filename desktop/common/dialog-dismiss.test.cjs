const test = require('node:test');
const assert = require('node:assert/strict');
test('only a complete outside click requests the Escape path on its own dialog', async () => {
  const { installDialogDismiss } = await import('../renderer/dialog-dismiss.mjs');
  const make = () => ({ open: true, requested: 0, handlers: {},
    getBoundingClientRect: () => ({ left: 10, right: 100, top: 10, bottom: 100 }),
    addEventListener(type, fn) { this.handlers[type] = fn; },
    requestClose() { this.requested++; },
  });
  const a = make(), b = make(); installDialogDismiss({ querySelectorAll: () => [a, b] });
  const event = (x, extra = {}) => ({ target: b, button: 0, detail: 1, pointerId: 1, clientX: x, clientY: 50, ...extra });
  for (const [from, to] of [[50, 0], [0, 50], [50, 50]]) {
    b.handlers.pointerdown(event(from)); b.handlers.click(event(to));
  }
  assert.equal(b.requested, 0);
  b.handlers.pointerdown(event(0, { button: 2 })); b.handlers.click(event(0));
  b.handlers.pointerdown(event(0)); b.handlers.pointercancel(); b.handlers.click(event(0));
  assert.equal(b.requested, 0);
  b.handlers.pointerdown(event(0)); b.handlers.click(event(0, { detail: 2 }));
  assert.equal(b.requested, 0, 'the rest of an opening double-click is not dismissal');
  b.handlers.pointerdown(event(0)); b.handlers.click(event(0));
  assert.equal(b.requested, 1); assert.equal(a.requested, 0);
  b.handlers.click(event(0)); assert.equal(b.requested, 1);
});
