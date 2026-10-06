"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { LOSSES } = require("./losses.mjs");
const report = () => ({
  counts: Object.fromEntries(
    Object.keys(LOSSES).map((kind) => [kind, kind === "ignored" ? 3 : 0]),
  ),
  bytes: Object.fromEntries(
    Object.keys(LOSSES).map((kind) => [kind, kind === "ignored" ? 20 : 0]),
  ),
  entries: [
    {
      kind: "ignored",
      path: "<img>\n\u202etest",
      sizeBytes: 12,
      directory: true,
      files: 2,
      sizeLowerBound: true,
    },
  ],
  warnings: ["filter <probe>\n"],
  sizeLowerBound: true,
});
function dom() {
  const nodes = new Map();
  const document = {
    querySelector(id) {
      if (!nodes.has(id))
        nodes.set(id, {
          textContent: "",
          innerHTML: "",
          open: false,
          isConnected: true,
          addEventListener(type, fn) {
            this[type] = fn;
          },
          focus() {
            document.activeElement = this;
          },
          showModal() {
            this.open = true;
          },
          close() {
            this.open = false;
            this.onclose?.();
          },
        });
      return nodes.get(id);
    },
  };
  // Keep the native method and the close event distinct.
  const dialog = document.querySelector("#files-dialog");
  dialog.addEventListener = (type, fn) => {
    if (type === "close") dialog.onclose = fn;
  };
  document.activeElement = document.querySelector("#opener");
  return document;
}
test("inventory rendering shows truncation and lower bounds and makes repository text visible", async () => {
  const { filesContent } = await import("../renderer/files-controller.mjs");
  const html = filesContent(report());
  assert.match(html, /Ignored files/);
  assert.match(html, /and 2 more/);
  assert.match(html, /at least 12 B/);
  assert.match(html, /at least 2 files/);
  assert.match(html, /&lt;img&gt;��test/);
  assert.match(html, /filter &lt;probe&gt;�/);
  assert.doesNotMatch(html, /<img>|\u202e/);
});
test("dialog loads, reports failure, restores focus and ignores late answers", async () => {
  const { createFilesController } =
    await import("../renderer/files-controller.mjs");
  const document = dom(),
    $ = (id) => document.querySelector(id);
  const pending = [];
  const api = {
    worktreeFiles(value) {
      return new Promise((resolve, reject) =>
        pending.push({ value, resolve, reject }),
      );
    },
  };
  const controller = createFilesController({
    document,
    api,
    workspace: { snapshot: { revision: "revision" } },
  });
  const first = controller.open({ id: "one", path: "/work/one" });
  assert.deepEqual(pending[0].value, { id: "one", revision: "revision" });
  assert.match($("#files-status").textContent, /Loading/);
  assert.equal(document.activeElement, $("#files-title"));
  $("#files-close").onclick();
  assert.equal(document.activeElement, $("#opener"));
  const second = controller.open({ id: "two", path: "/work/<two>\n" });
  pending[0].resolve(report());
  await first;
  assert.equal($("#files-content").innerHTML, "");
  pending[1].reject(new Error("offline\n<host>"));
  await second;
  assert.match($("#files-status").textContent, /offline�<host>/);
  const third = controller.open({ id: "three", path: "/work/three" });
  pending[2].resolve(report());
  await third;
  assert.equal($("#files-total").textContent, "3 items");
});

test("Show Files opened from consent offers Delete and reuses the current row; other entry points hide it", async () => {
  const { createFilesController } = await import("../renderer/files-controller.mjs");
  const document = dom(), $ = (id) => document.querySelector(id);
  const row = { id: "one", path: "/work/one" }, current = { ...row, head: "new" };
  const calls = [];
  const workspace = { snapshot: { revision: "current" }, items: [current], deleteWorktrees: (rows) => calls.push(rows) };
  const controller = createFilesController({ document, workspace, api: { worktreeFiles: async () => report() } });
  await controller.open(row, "current", { deleting: true });
  assert.equal($("#files-title").textContent, "Show Files — one");
  assert.equal($("#files-delete").hidden, false);
  $("#files-delete").onclick();
  assert.equal($("#files-dialog").open, false);
  assert.deepEqual(calls, [[current]]);
  await controller.open(row);
  assert.equal($("#files-delete").hidden, true);
  await controller.open(row, "current", { deleting: true });
  workspace.items = [];
  $("#files-delete").onclick();
  assert.equal(calls.length, 1, "a vanished row cannot be deleted");
});

test("remote files name the machine beside the path", async () => {
  const { createFilesController } = await import("../renderer/files-controller.mjs");
  const document = dom();
  const controller = createFilesController({ document, workspace: { snapshot: { revision: "r" } }, api: { worktreeFiles: async () => report() } });
  await controller.open({ id: "remote", path: "/work/topic", host: "build-host" });
  assert.equal(document.querySelector("#files-path").textContent, "build-host: /work/topic");
});
