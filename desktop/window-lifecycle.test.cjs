"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createWindowLifecycle } = require("./window-lifecycle.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(action) {
  let settle, answer;
  const calls = [];
  const idle = new Promise((resolve) => {
    settle = resolve;
  });
  const confirmation = new Promise((resolve) => {
    answer = resolve;
  });
  let abortController = null;
  const backend = {
    requestClose(options) {
      calls.push(["request", options]);
      return { action };
    },
    waitUntilIdle() {
      calls.push(["wait"]);
      return idle;
    },
  };
  const adapter = createWindowLifecycle({
    getBackend: () => backend,
    getWindow: () => ({
      isDestroyed: () => false,
      close: () => calls.push(["close"]),
    }),
    app: { quit: () => calls.push(["quit"]) },
    dialog: {
      showMessageBox: () => {
        calls.push(["prompt"]);
        return confirmation;
      },
    },
    getRemovalConfirmation: () => abortController,
  });
  return {
    calls,
    settle,
    answer,
    guard: adapter.guardClose,
    event: { preventDefault: () => calls.push(["prevent"]) },
    pendingRemoval() {
      abortController = new AbortController();
      return abortController;
    },
  };
}

test("idle close passes through; read-only close waits and repeated quit upgrades its window intent", async () => {
  const idle = fixture("close");
  idle.guard(idle.event);
  assert.deepEqual(
    idle.calls.map(([name]) => name),
    ["request"],
  );
  const active = fixture("wait");
  active.guard(active.event);
  active.guard(active.event, true);
  assert.equal(active.calls.filter(([name]) => name === "wait").length, 1);
  active.settle();
  await tick();
  assert.equal(active.calls.filter(([name]) => name === "quit").length, 1);
  assert.equal(active.calls.filter(([name]) => name === "close").length, 0);
});

test("window-only close remains a window close on macOS-style lifecycle", async () => {
  const f = fixture("wait");
  f.guard(f.event);
  f.settle();
  await tick();
  assert.equal(f.calls.filter(([name]) => name === "close").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "quit").length, 0);
});

test("declining cleanup close does not change backend consent or stop work", async () => {
  const f = fixture("confirm-cleanup");
  f.guard(f.event, true);
  f.guard(f.event, true);
  assert.equal(f.calls.filter(([name]) => name === "prompt").length, 1);
  f.answer({ response: 0 });
  await tick();
  assert.equal(f.calls.filter(([name]) => name === "wait").length, 0);
  assert.equal(
    f.calls.filter(
      ([name, options]) => name === "request" && options?.finishCleanup,
    ).length,
    0,
  );
});

test("confirmed cleanup waits for backend settlement before quitting", async () => {
  const f = fixture("confirm-cleanup");
  f.guard(f.event);
  f.answer({ response: 1 });
  await tick();
  assert.ok(
    f.calls.some(
      ([name, options]) => name === "request" && options?.finishCleanup,
    ),
  );
  assert.equal(f.calls.filter(([name]) => name === "quit").length, 0);
  f.settle();
  await tick();
  assert.equal(f.calls.filter(([name]) => name === "quit").length, 1);
});

test("closing an open removal confirmation aborts that consent without another prompt", async () => {
  const f = fixture("confirm-cleanup");
  const confirmation = f.pendingRemoval();
  f.guard(f.event);
  assert.equal(confirmation.signal.aborted, true);
  assert.equal(f.calls.filter(([name]) => name === "prompt").length, 0);
  f.settle();
  await tick();
  assert.equal(f.calls.filter(([name]) => name === "quit").length, 1);
});
