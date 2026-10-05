"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

async function fixture() {
  const { createPreferencesController } = await import(
    "../renderer/preferences-controller.mjs"
  );
  const elements = new Map(),
    calls = [];
  const element = (selector) => {
    if (!elements.has(selector))
      elements.set(selector, {
        value: "",
        dataset: {},
        hidden: false,
        disabled: false,
        checked: false,
        open: false,
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
        focus() {},
        reset() {},
      });
    return elements.get(selector);
  };
  const controller = createPreferencesController({
    document: { querySelector: element, documentElement: { dataset: {} } },
    defaults: { excludes: ["default-cache"] },
    api: {
      async savePreferences(value) {
        calls.push(["save", structuredClone(value)]);
      },
      async chooseFolder() {
        calls.push(["choose-folder"]);
        return "/chosen";
      },
    },
    notify: (...args) => calls.push(["notice", ...args]),
    onScan: (value) => calls.push(["scan", value]),
    onHostChange: (value) => calls.push(["filter", value]),
    onSetup() {},
    onReset() {},
  });
  controller.initialize({
    theme: "system",
    roots: ["/saved-local"],
    hosts: [{ host: "vps", name: "Build server", root: "/saved-remote" }],
    scan: { root: "/saved-local", excludes: ["old"] },
  });
  const status = {
    host: "",
    hostFilter: null,
    root: "",
    connected: true,
    blocked: false,
    busy: true,
    hosts: [
      {
        host: "",
        root: "/local",
        busy: false,
        options: { github: false, fetch: true, excludes: ["local-cache"] },
      },
      {
        host: "vps",
        root: "/remote",
        busy: true,
        options: { github: true, fetch: false, excludes: ["remote-cache"] },
      },
    ],
  };
  controller.renderStatus(status);
  const choose = (dataset, all = false) =>
    element("#machine-list").listeners.click({
      target: {
        closest: () => ({
          dataset,
          disabled: false,
          hasAttribute: (name) => all && name === "data-all-hosts",
        }),
      },
    });
  return { controller, element, calls, status, choose };
}

test("host picker distinguishes All/null, local/empty and SSH aliases without starting scans", async () => {
  const f = await fixture();
  assert.equal(
    f.element("#machine-button").disabled,
    false,
    "background scanning must not lock navigation",
  );
  assert.equal(f.element("#machine-label").textContent, "All hosts");
  assert.equal(f.element("#root-label").textContent, "All configured hosts");
  assert.equal(f.element("#machine-icon").dataset.kind, "server");
  f.controller.openMachines();
  const markup = f.element("#machine-list").innerHTML;
  assert.match(markup, /machine-option active[^>]*data-all-hosts/);
  assert.match(markup, /data-host=""/);
  assert.match(markup, /data-host="vps"/);
  await f.choose({ host: "" });
  assert.deepEqual(f.calls, [["filter", ""]]);
  assert.equal(f.element("#machine-dialog").open, false);
  f.controller.renderStatus({ ...f.status, hostFilter: "", root: "/local" });
  assert.equal(f.element("#machine-icon").dataset.kind, "monitor");
  assert.equal(f.element("#machine-label").textContent, "This computer");
  await f.choose({}, true);
  await f.choose({ host: "vps" });
  assert.deepEqual(f.calls, [
    ["filter", ""],
    ["filter", null],
    ["filter", "vps"],
  ]);
  f.controller.renderStatus({
    ...f.status,
    host: "vps",
    hostFilter: "vps",
    root: "/remote",
  });
  assert.equal(f.element("#machine-label").textContent, "Build server");
  assert.equal(f.element("#machine-icon").dataset.kind, "server");
  assert.equal(f.element("#root-label").textContent, "vps:/remote");
  await f.choose({ host: "vps" });
  assert.equal(f.calls.length, 3, "reselecting current filter is a no-op");
  assert.equal(
    f.calls.some(([name]) => name === "scan" || name === "save"),
    false,
  );
});

test("explicit session-only hosts remain selectable and settings never silently target local", async () => {
  const f = await fixture();
  f.controller.renderStatus({
    ...f.status,
    host: "adhoc",
    hostFilter: "adhoc",
    hosts: [
      ...f.status.hosts,
      {
        host: "adhoc",
        label: "adhoc",
        sessionOnly: true,
        root: "/remote/session",
        options: { excludes: ["remote-only"] },
        busy: false,
      },
    ],
  });
  f.controller.openMachines();
  assert.match(f.element("#machine-list").innerHTML, /data-host="adhoc"/);
  assert.doesNotMatch(
    f.element("#machine-list").innerHTML,
    /data-forget-host="adhoc"/,
  );
  f.controller.openSettings();
  assert.match(f.element("#settings-host").innerHTML, /value="adhoc"/);
  assert.equal(f.element("#settings-host").value, "adhoc");
  assert.equal(f.element("#scan-root").value, "/remote/session");
  assert.equal(f.element("#scan-excludes").value, "remote-only");
  assert.equal(f.element("#choose-folder").hidden, true);
  f.element("#settings-form").onsubmit({ preventDefault() {} });
  assert.equal(f.calls.at(-1)[0], "scan");
  assert.equal(f.calls.at(-1)[1].host, "adhoc");
});

test("All-host settings edit a specific machine independently and gate only its own scan", async () => {
  const f = await fixture();
  f.controller.openSettings();
  assert.equal(f.element("#settings-host").value, "");
  assert.doesNotMatch(f.element("#settings-host").innerHTML, /All hosts/);
  assert.equal(f.element("#scan-root").value, "/local");
  assert.equal(f.element("#scan-excludes").value, "local-cache");
  assert.equal(f.element("#scan-fetch").checked, true);
  assert.equal(f.element("#choose-folder").hidden, false);
  assert.equal(
    f.element("#settings-save").disabled,
    false,
    "remote scan cannot block local settings",
  );
  f.element("#settings-host").value = "vps";
  f.element("#settings-host").onchange();
  assert.equal(f.element("#scan-root").value, "/remote");
  assert.equal(f.element("#scan-excludes").value, "remote-cache");
  assert.equal(f.element("#scan-github").checked, true);
  assert.equal(f.element("#choose-folder").hidden, true);
  assert.equal(f.element("#settings-save").disabled, true);
  assert.equal(f.element("#settings-progress").hidden, false);
  f.element("#settings-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(f.calls, [], "busy machine cannot submit another scan");
  f.controller.renderStatus({
    ...f.status,
    hosts: f.status.hosts.map((source) => ({ ...source, busy: false })),
  });
  f.element("#scan-root").value = "/remote/new";
  f.element("#scan-excludes").value = "~/.codex*/.tmp\nfolder,with,commas";
  f.element("#theme-select").value = "dark";
  f.element("#settings-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(f.calls, [
    [
      "scan",
      {
        root: "/remote/new",
        host: "vps",
        github: true,
        fetch: false,
        excludes: ["~/.codex*/.tmp", "folder,with,commas"],
        theme: "dark",
      },
    ],
  ]);
  assert.equal(
    f.element("#machine-label").textContent,
    "All hosts",
    "editing a machine does not change the browse filter",
  );
});

test("All-host path control opens settings; adding a host saves before selecting without scanning", async () => {
  const f = await fixture();
  await f.element("#path-button").onclick();
  assert.equal(f.element("#settings-dialog").open, true);
  assert.deepEqual(
    f.calls,
    [],
    "All-host settings must not choose a local filesystem path implicitly",
  );
  f.element("#host-input").value = "_new-host";
  await f.element("#host-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ["save", "filter"],
  );
  assert.equal(f.calls[0][1].hosts.at(-1).host, "_new-host");
  assert.deepEqual(f.calls[1], ["filter", "_new-host"]);
});
