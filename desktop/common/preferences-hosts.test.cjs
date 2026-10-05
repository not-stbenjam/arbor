"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

async function fixture() {
  const { createPreferencesController } = await import(
    "../renderer/preferences-controller.mjs"
  );
  const elements = new Map(),
    calls = [],
    // Set `save` to a message to make the next saves fail with it, and `scan`
    // to make the next scans be refused with it. `scanning` holds a scan
    // unanswered until it is called.
    failure = { save: "", scan: "", scanning: null };
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
        querySelector: () => null,
      });
    return elements.get(selector);
  };
  const controller = createPreferencesController({
    document: { querySelector: element, documentElement: { dataset: {} } },
    defaults: { excludes: ["default-cache"] },
    api: {
      async savePreferences(value) {
        if (failure.save) throw new Error(failure.save);
        calls.push(["save", structuredClone(value)]);
      },
      async chooseFolder() {
        calls.push(["choose-folder"]);
        return "/chosen";
      },
    },
    notify: (...args) => calls.push(["notice", ...args]),
    onScan: async (value) => {
      calls.push(["scan", value]);
      if (failure.scanning) await new Promise((answer) => (failure.scanning = answer));
      return failure.scan ? { error: failure.scan } : {};
    },
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
  return { controller, element, calls, status, choose, failure };
}

test("host picker distinguishes All/null, local/empty and SSH aliases without starting scans", async () => {
  const f = await fixture();
  assert.equal(
    f.element("#machine-button").disabled,
    false,
    "background scanning must not lock navigation",
  );
  assert.equal(f.element("#machine-label").textContent, "All hosts");
  assert.equal(f.element("#root-label").textContent, "Folders on all hosts");
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
  await f.element("#settings-form").onsubmit({ preventDefault() {} });
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
  await f.element("#settings-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(f.calls, [], "busy machine cannot submit another scan");
  f.controller.renderStatus({
    ...f.status,
    hosts: f.status.hosts.map((source) => ({ ...source, busy: false })),
  });
  f.element("#scan-root").value = "/remote/new";
  f.element("#scan-excludes").value = "~/.codex*/.tmp\nfolder,with,commas";
  f.element("#theme-select").value = "dark";
  f.element("#theme-select").onchange();
  await f.element("#settings-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(
    f.calls.filter(([name]) => name === "save").map(([, value]) => value.theme),
    ["dark"],
    "appearance saves when chosen, apart from any scan",
  );
  assert.deepEqual(
    f.calls.filter(([name]) => name === "scan"),
    [
    [
      "scan",
      {
        root: "/remote/new",
        host: "vps",
        github: true,
        fetch: false,
        excludes: ["~/.codex*/.tmp", "folder,with,commas"],
      },
    ],
    ],
  );
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
  // A new host's first scan starts as soon as it is saved, so the folder to
  // scan is chosen with it rather than found afterwards to be all of home.
  f.element("#host-input").value = "_new-host";
  f.element("#host-root").value = " ~/projects ";
  await f.element("#host-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ["save", "filter"],
  );
  assert.equal(f.calls[0][1].hosts.at(-1).host, "_new-host");
  assert.equal(f.calls[0][1].hosts.at(-1).root, "~/projects");
  assert.deepEqual(f.calls[1], ["filter", "_new-host"]);
  assert.equal(f.element("#host-root").value, "~", "the form resets");
  f.element("#host-input").value = "second-host";
  f.element("#host-root").value = "";
  await f.element("#host-form").onsubmit({ preventDefault() {} });
  assert.equal(f.calls.at(-2)[1].hosts.at(-1).root, "~");

  // The dialog covers the window's notifications, so a problem with the form
  // is reported inside it and the entry is kept for correction.
  f.calls.length = 0;
  f.element("#host-input").value = "not a host";
  await f.element("#host-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(f.calls, [], "nothing is saved, selected, or toasted");
  assert.equal(f.element("#host-error").hidden, false);
  assert.match(f.element("#host-error").textContent, /without spaces/);
  assert.equal(f.element("#host-input").value, "not a host");
  f.element("#host-input").value = "third-host";
  await f.element("#host-form").onsubmit({ preventDefault() {} });
  assert.equal(f.element("#host-error").hidden, true);
});

test("a host that is already saved, or could not be saved, never keeps a folder nobody chose", async () => {
  const f = await fixture();
  const submit = () => f.element("#host-form").onsubmit({ preventDefault() {} });
  const saved = () => f.calls.filter(([name]) => name === "save");
  // The folder typed beside a saved host would be accepted and ignored.
  f.element("#host-input").value = "vps";
  f.element("#host-root").value = "/somewhere/else";
  await submit();
  assert.deepEqual(f.calls, [], "nothing is saved or selected");
  assert.match(f.element("#host-error").textContent, /already saved/);
  assert.equal(f.element("#host-input").value, "vps", "the entry is kept");

  // A save that fails leaves no host behind, so the retry can correct it.
  f.failure.save = "disk full";
  f.element("#host-input").value = "build";
  f.element("#host-root").value = "/wrong";
  await submit();
  assert.deepEqual(f.calls, []);
  assert.equal(
    f.element("#host-error").textContent,
    "Could not save this host: disk full",
  );
  f.failure.save = "";
  f.element("#host-root").value = "/correct";
  await submit();
  assert.equal(saved().length, 1);
  assert.deepEqual(
    saved()[0][1].hosts.map(({ host, root }) => [host, root]),
    [
      ["vps", "/saved-remote"],
      ["build", "/correct"],
    ],
  );
  assert.equal(f.element("#host-error").hidden, true);
  assert.deepEqual(f.calls.at(-1), ["filter", "build"]);
});

test("settings keep each host's unsaved edits, and say when appearance could not be saved", async () => {
  const f = await fixture();
  f.controller.renderStatus({
    ...f.status,
    hosts: f.status.hosts.map((source) => ({ ...source, busy: false })),
  });
  const choose = (host) => {
    f.element("#settings-host").value = host;
    f.element("#settings-host").onchange();
  };
  const submit = () =>
    f.element("#settings-form").onsubmit({ preventDefault() {} });
  f.controller.openSettings();
  f.element("#scan-root").value = "/draft-local";
  f.element("#scan-fetch").checked = false;
  // Asking for Settings again, by its shortcut or the menu, changes nothing.
  f.controller.openSettings();
  assert.equal(f.element("#scan-root").value, "/draft-local");
  // Looking at another host's options does not discard these.
  choose("vps");
  assert.equal(f.element("#scan-root").value, "/remote");
  assert.match(
    f.element("#settings-host").innerHTML,
    /<option value="">This computer \(unsaved changes\)<\/option>/,
  );
  assert.doesNotMatch(
    f.element("#settings-host").innerHTML,
    /Build server \(unsaved changes\)/,
  );
  f.element("#scan-root").value = "/draft-remote";
  choose("");
  assert.equal(f.element("#scan-root").value, "/draft-local");
  assert.equal(f.element("#scan-fetch").checked, false);
  choose("vps");
  assert.equal(f.element("#scan-root").value, "/draft-remote");

  // Save & scan applies the host on screen. The other edited host is shown
  // next, still edited, instead of being dropped unseen.
  await submit();
  assert.deepEqual(
    f.calls.filter(([name]) => name === "scan").map(([, scan]) => [scan.host, scan.root]),
    [["vps", "/draft-remote"]],
  );
  assert.equal(f.element("#settings-dialog").open, true);
  assert.equal(f.element("#settings-host").value, "");
  assert.equal(f.element("#scan-root").value, "/draft-local");
  assert.equal(
    f.element("#settings-note").textContent,
    "Scanning Build server with its new settings. This computer still has unsaved changes.",
  );
  await submit();
  assert.deepEqual(
    f.calls.filter(([name]) => name === "scan").map(([, scan]) => [scan.host, scan.root]),
    [
      ["vps", "/draft-remote"],
      ["", "/draft-local"],
    ],
  );
  assert.equal(f.element("#settings-dialog").open, false);

  // Reopening starts from what is saved, not from an abandoned edit.
  f.controller.openSettings();
  f.element("#scan-root").value = "/abandoned";
  f.element("#settings-dialog").close();
  f.controller.openSettings();
  assert.equal(f.element("#scan-root").value, "/local");
  assert.equal(f.element("#settings-note").hidden, true);

  // The dialog covers the window's notifications, so a failed save of the
  // appearance is reported inside it.
  f.calls.length = 0;
  f.failure.save = "read-only profile";
  f.element("#theme-select").value = "dark";
  await f.element("#theme-select").onchange();
  assert.deepEqual(f.calls, [], "no toast behind the dialog");
  assert.equal(
    f.element("#settings-error").textContent,
    "Appearance changed for this session, but could not be saved: read-only profile",
  );
  f.failure.save = "";
  await f.element("#theme-select").onchange();
  assert.equal(f.element("#settings-error").hidden, true);
});

test("Settings stays open until its scan is taken up, and a refused scan is put right there", async () => {
  const f = await fixture();
  f.controller.renderStatus({
    ...f.status,
    hosts: f.status.hosts.map((source) => ({ ...source, busy: false })),
  });
  const submit = () =>
    f.element("#settings-form").onsubmit({ preventDefault() {} });
  const scans = () => f.calls.filter(([name]) => name === "scan").length;
  f.controller.openSettings();
  f.element("#scan-root").value = "/no/such/folder";
  f.element("#scan-excludes").value = "typed-with-care";

  // While the backend has not answered, the dialog is still there and a
  // second press starts nothing.
  f.failure.scanning = true;
  f.failure.scan = "scan folder does not exist: /no/such/folder";
  const asked = submit();
  assert.equal(f.element("#settings-dialog").open, true);
  assert.equal(f.element("#settings-save").disabled, true);
  assert.equal(f.element("#settings-save").textContent, "Starting scan…");
  await submit();
  assert.equal(scans(), 1);
  f.failure.scanning();
  f.failure.scanning = null;
  await asked;

  // Refused: the reason is in the dialog, which keeps everything typed.
  assert.equal(f.element("#settings-dialog").open, true);
  assert.equal(
    f.element("#settings-error").textContent,
    "scan folder does not exist: /no/such/folder",
  );
  assert.equal(f.element("#settings-error").hidden, false);
  assert.equal(f.element("#scan-root").value, "/no/such/folder");
  assert.equal(f.element("#scan-excludes").value, "typed-with-care");
  assert.equal(f.element("#settings-save").disabled, false);
  assert.equal(f.element("#settings-save").textContent, "Save & scan");

  // Corrected and taken up: the error goes and the dialog closes.
  f.failure.scan = "";
  f.element("#scan-root").value = "/local/fixed";
  await submit();
  assert.equal(scans(), 2);
  assert.equal(f.element("#settings-error").hidden, true);
  assert.equal(f.element("#settings-dialog").open, false);

  // Closed while the question was out: it is not closed or cleared again
  // when the answer comes.
  f.controller.openSettings();
  f.element("#scan-root").value = "/local/again";
  f.failure.scanning = true;
  const late = submit();
  f.element("#settings-dialog").close();
  f.failure.scanning();
  f.failure.scanning = null;
  await late;
  assert.equal(f.element("#settings-dialog").open, false);
});
