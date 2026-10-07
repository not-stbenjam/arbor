import { createHostMenu } from "./host-menu.mjs";
import { icon, esc, viewHost } from "./presentation.mjs";
import {
  isValidSSHHost,
  MAX_HOST_LENGTH,
  MAX_HOST_LABEL_LENGTH,
} from "../common/ssh-host.mjs";
import { readExcludes, summarizeExcludes } from "./input-values.mjs";

// Owns preference editors and the last canonical preferences read from main.
// Scan requests are emitted as commands; only main persists active scan choices.
export function createPreferencesController({
  document,
  api,
  defaults,
  notify,
  onScan,
  onStopScan = () => {},
  onHostChange,
  onSetup,
  onReset,
}) {
  const $ = (selector) => document.querySelector(selector);
  $("#host-input").maxLength = MAX_HOST_LENGTH;
  $("#host-name").maxLength = MAX_HOST_LABEL_LENGTH;
  const showExcludeCount = summarizeExcludes(
    $("#scan-excludes"),
    $("#scan-excludes-count"),
  );
  const showSafeIgnoredCount = summarizeExcludes(
    $("#scan-safe-ignored"),
    $("#scan-safe-ignored-count"),
  );
  let prefs = { hosts: [], roots: [], theme: "system", scan: {} };
  let context = {
    root: "",
    host: "",
    hostFilter: null,
    hosts: [],
    setupRequired: false,
    blocked: true,
    connected: false,
  };
  let loadGeneration = 0;
  let editingHost = "";
  // Save & scan has been pressed and the backend has not yet answered.
  let submitting = false;
  // Which form is on screen: a new number each time Settings is opened or
  // turned to another host. An answer to an earlier one is not this one's.
  let sitting = 0;
  // Unsaved edits, kept per host while Settings is open, so looking at
  // another host's options does not throw away the ones being changed.
  const drafts = new Map();
  const hostFilter = () =>
    viewHost({ hostFilter: context.hostFilter, hosts: machines() });
  const machines = () => [
    { host: "", name: "This computer" },
    ...prefs.hosts,
    ...context.hosts
      .filter(
        (source) =>
          source.sessionOnly &&
          !prefs.hosts.some((saved) => saved.host === source.host),
      )
      .map((source) => ({
        host: source.host,
        name: source.label || source.host,
        sessionOnly: true,
      })),
  ];
  const hostName = (host) =>
    host === null
      ? "All hosts"
      : host
        ? prefs.hosts.find((entry) => entry.host === host)?.name || host
        : "This computer";
  const options = () => {
    const value = context.options || prefs.scan || {};
    return {
      github: !!value.github,
      fetch: !!value.fetch,
      excludes: [...(value.excludes || defaults.excludes)],
      safeIgnored: [...(value.safeIgnored ?? defaults.safeIgnored ?? [])],
    };
  };
  const systemTheme = document.defaultView?.matchMedia("(prefers-color-scheme: dark)");
  const nextTheme = () => (prefs.theme === "dark" ||
    (prefs.theme === "system" && systemTheme?.matches)) ? "light" : "dark";
  systemTheme?.addEventListener("change", () => applyTheme());
  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
    $("#theme-select").value = prefs.theme;
    $("#theme-button").innerHTML = icon(
      nextTheme() === "dark" ? "moon" : "sun",
    );
    $("#theme-button").title = `Switch to ${nextTheme()} mode`;
    $("#theme-button").ariaLabel = $("#theme-button").title;
  }
  function setTheme(theme) {
    prefs.theme = theme;
    applyTheme();
  }
  function initialize(saved) {
    prefs = { ...prefs, ...structuredClone(saved) };
    prefs.hosts = Array.isArray(prefs.hosts)
      ? prefs.hosts.filter((h) => h && typeof h.host === "string")
      : [];
    prefs.roots = Array.isArray(prefs.roots) ? prefs.roots : [];
    if (!["system", "light", "dark"].includes(prefs.theme))
      prefs.theme = "system";
    applyTheme();
  }
  async function load() {
    const generation = ++loadGeneration;
    const saved = await api.getPreferences();
    if (generation === loadGeneration) initialize(saved);
  }
  async function save(strict = false) {
    ++loadGeneration;
    try {
      await api.savePreferences(structuredClone(prefs));
    } catch (error) {
      if (strict) throw error;
      notify(`Could not save settings: ${error.message}`, true);
    }
  }
  function renderStatus(next) {
    context = next;
    const selected = hostFilter();
    const machine = hostName(selected);
    const local = context.hosts.find((source) => source.host === "");
    const root = context.root || (selected === "" ? local?.report?.root || local?.root : "");
    const path =
      selected === null
        ? ""
        : `${selected ? `${selected}:` : ""}${root || "Home folder"}`;
    $("#machine-label").textContent = machine;
    $("#machine-label").title = machine;
    const kind = selected === "" ? "monitor" : "server";
    $("#machine-icon").innerHTML = icon(kind);
    $("#machine-icon").dataset.kind = kind;
    $("#path-location").hidden = selected === null;
    $("#root-label").textContent = path;
    $("#root-label").dataset.kind = selected === null ? "scope" : "path";
    // The local folder opens a picker; a remote one is edited in Settings.
    // All hosts is a scope with no single folder behind it.
    $("#path-button").title =
      selected === null
        ? ""
        : selected === ""
          ? `Scanning ${path}. Choose another folder…`
          : `Scanning ${path}. Change in Settings…`;
    $("#machine-button").disabled = context.blocked || machines().length < 2;
    $("#path-button").disabled = context.blocked;
    const editingState = context.hosts.find(
      (source) => source.host === editingHost,
    );
    $("#settings-save").disabled =
      context.blocked || !!editingState?.busy || submitting;
    $("#scan-options-button").disabled = context.setupRequired;
    $("#reset-preferences").disabled =
      !context.connected ||
      context.resetting ||
      context.removing ||
      (context.busy && !context.canCancelScan && !context.cancelRequested);
    $("#reset-preferences").textContent = context.resetting
      ? "Resetting…"
      : "Reset to defaults…";
    $("#settings-save").textContent = context.removing
      ? "Cleanup in progress…"
      : editingState?.busy
        ? "Scanning…"
        : submitting
          ? "Starting scan…"
          : "Save & scan";
    $('#host-form button[type="submit"]').disabled = context.blocked;
    // Settings covers the window's own Stop, and closing it to reach that
    // would throw away what was being changed here. So it has one.
    const scanning = !!editingState?.busy,
      stopping = !!editingState?.cancelRequested,
      stop = $("#settings-stop"),
      held = document.activeElement === stop;
    $("#settings-progress").hidden = !scanning;
    $("#settings-progress-text").textContent = scanning
      ? `${hostName(editingHost)} is still scanning. What you change here is kept: save when the scan finishes, or stop it now.`
      : "";
    stop.hidden = !scanning || !(editingState.canCancelScan || stopping);
    // Pressing it again while it stops does nothing; disabling it would
    // drop the keyboard that is on it.
    stop.textContent = stopping ? "Stopping…" : "Stop scan";
    // Once it has stopped, the next thing to do is save.
    if (held && stop.hidden) $("#settings-save").focus();
  }
  // What Settings shows for a host before anything is edited.
  function savedForm(host) {
    const source = context.hosts.find((entry) => entry.host === host);
    const scan = source?.options || options();
    return {
      root:
        source?.root ||
        (host
          ? prefs.hosts.find((entry) => entry.host === host)?.root
          : prefs.roots[0]) ||
        "~",
      github: !!scan.github,
      fetch: !!scan.fetch,
      excludes: (scan.excludes || defaults.excludes).join("\n"),
      safeIgnored: (scan.safeIgnored ?? defaults.safeIgnored ?? []).join("\n"),
    };
  }
  const readForm = () => ({
    root: $("#scan-root").value,
    github: $("#scan-github").checked,
    fetch: $("#scan-fetch").checked,
    excludes: $("#scan-excludes").value,
    safeIgnored: $("#scan-safe-ignored").value,
  });
  const edited = (host) =>
    drafts.has(host) &&
    JSON.stringify(drafts.get(host)) !== JSON.stringify(savedForm(host));
  function renderHostChoices(selected) {
    $("#settings-host").innerHTML = machines()
      .map(
        (entry) =>
          `<option value="${esc(entry.host)}">${esc(entry.name || entry.host)}${edited(entry.host) ? " (unsaved changes)" : ""}</option>`,
      )
      .join("");
    $("#settings-host").value = selected;
  }
  function editHost(host) {
    sitting++;
    editingHost = host;
    const form = drafts.get(host) || savedForm(host);
    $("#scan-root").value = form.root;
    $("#scan-github").checked = form.github;
    $("#scan-fetch").checked = form.fetch;
    $("#scan-excludes").value = form.excludes;
    $("#scan-safe-ignored").value = form.safeIgnored;
    showExcludeCount();
    showSafeIgnoredCount();
    $("#choose-folder").hidden = !!host;
    $("#root-help").textContent = host
      ? `A folder on ${host}. ~ is its home folder. Arbor finds the Git repositories there and lists their linked worktrees.`
      : "Arbor finds the Git repositories in this folder and lists their linked worktrees.";
    renderStatus(context);
  }
  function openSettings() {
    if (context.setupRequired) {
      onSetup();
      return;
    }
    // Asked for again while open, by its shortcut or the menu, it is already
    // showing what is being edited.
    if ($("#settings-dialog").open) return;
    drafts.clear();
    fieldError("#settings-error");
    fieldNote();
    renderHostChoices(hostFilter() || "");
    editHost($("#settings-host").value);
    $("#theme-select").value = prefs.theme;
    $("#settings-dialog").showModal();
  }
  // A dialog covers the window's notifications, so its own problems are
  // reported inside it, beside the field they concern.
  function fieldError(selector, message = "") {
    $(selector).textContent = message;
    $(selector).hidden = !message;
  }
  const fieldNote = (message = "") => fieldError("#settings-note", message);
  function openMachines() {
    if (context.blocked) return;
    const failed = new Set(
      context.hosts
        .filter((source) => source.error && !source.busy)
        .map((source) => source.host),
    );
    $("#machine-list").innerHTML = [
      ...(machines().length > 1 ? [{ host: null, name: "All hosts" }] : []),
      ...machines(),
    ]
      .map((h) => {
        const current = h.host === hostFilter();
        const displayName = h.name === h.host?.slice(0, MAX_HOST_LABEL_LENGTH) ? "" : h.name || "";
        return `<div class="machine-row"><button class="machine-option${current ? " active" : ""}" ${h.host === null ? "data-all-hosts" : `data-host="${esc(h.host)}"`}${current ? ' aria-current="true"' : ""}>${icon(h.host !== "" ? "server" : "monitor")}<span>${esc(h.name || h.host)}</span>${failed.has(h.host) ? `<span class="machine-status" title="Its last scan failed. Select it to see why.">Unavailable</span>` : ""}${current ? icon("check") : ""}</button>${h.host && !h.sessionOnly ? `<input class="host-name text-input" data-host-name="${esc(h.host)}" value="${esc(displayName)}" placeholder="${esc(h.host)}" maxlength="${MAX_HOST_LABEL_LENGTH}" aria-label="Display name for ${esc(h.host)} (optional)" title="Display name for ${esc(h.host)}; leave blank to use the SSH host"><button class="icon-button" data-forget-host="${esc(h.host)}" title="Forget this host. Its worktrees are not touched." aria-label="Forget ${esc(h.host)}; its worktrees are not touched">${icon("minus")}</button>` : ""}</div>`;
      })
      .join("");
    fieldError("#host-error");
    if (!$("#machine-dialog").open) $("#machine-dialog").showModal();
    $("#machine-list").querySelector(".machine-option.active")?.focus();
  }
  function switchHost(host) {
    $("#machine-dialog").close();
    if (host === hostFilter()) return;
    return onHostChange(host);
  }
  function reset(saved, state) {
    ++loadGeneration;
    initialize(saved);
    $("#settings-form").reset();
    $("#scan-safe-ignored").value = (state.options?.safeIgnored ?? saved.scan?.safeIgnored ?? defaults.safeIgnored ?? []).join("\n");
    $("#host-form").reset();
    $("#scan-excludes").value = (
      state.options?.excludes ||
      saved.scan?.excludes ||
      defaults.excludes
    ).join("\n");
    showExcludeCount();
    showSafeIgnoredCount();
    $("#scan-root").value = state.root || saved.scan?.root || "~";
    $("#scan-github").checked = !!saved.scan?.github;
    $("#scan-fetch").checked = !!saved.scan?.fetch;
  }
  $("#settings-button").onclick = openSettings;
  $("#settings-host").onchange = () => {
    const next = $("#settings-host").value;
    drafts.set(editingHost, readForm());
    renderHostChoices(next);
    editHost(next);
  };
  $("#scan-options-button").onclick = openSettings;
  createHostMenu({
    document,
    choices: () => [
      ...(machines().length > 1 ? [{ host: null, name: "All hosts" }] : []),
      ...machines(),
    ],
    selected: hostFilter,
    choose: switchHost,
    manage: openMachines,
  });
  $("#add-host").onclick = () => {
    openMachines();
    $("#host-input").focus();
  };
  $("#scan-reset-safe-ignored").onclick = () => {
    $("#scan-safe-ignored").value = (defaults.safeIgnored || []).join("\n");
    showSafeIgnoredCount();
  };
  $("#scan-reset-excludes").onclick = () => {
    $("#scan-excludes").value = defaults.excludes.join("\n");
    showExcludeCount();
  };
  // Appearance is not a scan setting: it applies at once, like the toggle
  // beside the version, and Save & scan has nothing to do with it.
  $("#theme-select").onchange = async () => {
    setTheme($("#theme-select").value);
    fieldError("#settings-error");
    try {
      await save(true);
    } catch (error) {
      fieldError(
        "#settings-error",
        `Appearance changed for this session, but could not be saved: ${error.message}`,
      );
    }
  };
  $("#settings-stop").onclick = () => onStopScan(editingHost);
  $("#reset-preferences").onclick = () => {
    if (!$("#reset-preferences").disabled) onReset();
  };
  $("#theme-button").onclick = () => {
    setTheme(nextTheme());
    save();
  };
  $("#choose-folder").onclick = async () => {
    fieldError("#settings-error");
    try {
      const root = await api.chooseFolder();
      if (root) $("#scan-root").value = root;
    } catch (error) {
      fieldError("#settings-error", error.message);
    }
  };
  $("#path-button").onclick = async () => {
    if (hostFilter() === null) return;
    if (hostFilter() !== "") {
      openSettings();
      return;
    }
    try {
      const root = await api.chooseFolder();
      if (root) onScan({ root, host: "", ...options() });
    } catch (error) {
      notify(error.message, true);
    }
  };
  $("#settings-form").onsubmit = async (event) => {
    event.preventDefault();
    if ($("#settings-save").disabled || submitting) return;
    const host = editingHost;
    const scan = {
      root: $("#scan-root").value.trim(),
      host,
      github: $("#scan-github").checked,
      fetch: $("#scan-fetch").checked,
      excludes: readExcludes($("#scan-excludes")),
      safeIgnored: readExcludes($("#scan-safe-ignored")),
    };
    // The dialog stays until the scan is taken up. One that is refused, for
    // a folder that does not exist, say, is put right here, with everything
    // else still as it was typed.
    fieldError("#settings-error");
    fieldNote();
    const asked = sitting,
      sent = JSON.stringify(readForm());
    submitting = true;
    renderStatus(context);
    let outcome;
    try {
      outcome = await onScan(scan);
    } finally {
      submitting = false;
      renderStatus(context);
    }
    // Closed, opened afresh, or turned to another host while the scan was
    // being asked for: the answer is not about what is on screen now. A
    // refusal is still shown in the window behind.
    if (!$("#settings-dialog").open || sitting !== asked) return;
    if (outcome?.error) {
      fieldError("#settings-error", outcome.error);
      return;
    }
    // Edited again while waiting: the scan has what was sent, and what was
    // typed since is still here to be sent.
    if (JSON.stringify(readForm()) !== sent) {
      drafts.set(host, readForm());
      fieldNote(
        `Scanning ${hostName(host)} with the settings as they were when you pressed Save & scan. Your changes since are not applied yet.`,
      );
      return;
    }
    drafts.delete(host);
    // Save & scan applies the host on screen. Another host edited in the
    // same sitting is shown next instead of being dropped unseen.
    const pending = machines().find((entry) => edited(entry.host));
    if (pending) {
      renderHostChoices(pending.host);
      editHost(pending.host);
      fieldNote(
        `Scanning ${hostName(host)} with its new settings. ${hostName(pending.host)} still has unsaved changes.`,
      );
    } else $("#settings-dialog").close();
  };
  $("#host-form").onsubmit = async (event) => {
    event.preventDefault();
    const host = $("#host-input").value.trim();
    if (!isValidSSHHost(host)) {
      fieldError(
        "#host-error",
        host.length > MAX_HOST_LENGTH
          ? `An SSH host can be at most ${MAX_HOST_LENGTH} characters.`
          : "Enter an SSH alias or user@hostname, without spaces or options.",
      );
      $("#host-input").focus();
      return;
    }
    // The folder typed here would otherwise be accepted and ignored.
    if (prefs.hosts.some((saved) => saved.host === host)) {
      fieldError(
        "#host-error",
        "This host is already saved. Select it above; its scan folder is changed in Settings.",
      );
      $("#host-input").focus();
      return;
    }
    // Its first scan starts as soon as it is saved, so the folder is chosen
    // here rather than discovered afterwards to be the whole home folder. It
    // joins the saved hosts only once saving worked: a retry must be able to
    // correct the folder.
    const saved = prefs.hosts;
    prefs.hosts = [
      ...saved,
      {
        name: $("#host-name").value.trim().slice(0, MAX_HOST_LABEL_LENGTH) || host.slice(0, MAX_HOST_LABEL_LENGTH),
        host,
        root: $("#host-root").value.trim() || "~",
      },
    ];
    try {
      await save(true);
    } catch (error) {
      prefs.hosts = saved;
      fieldError("#host-error", `Could not save this host: ${error.message}`);
      return;
    }
    fieldError("#host-error");
    $("#host-input").value = "";
    $("#host-name").value = "";
    $("#host-root").value = "~";
    return switchHost(host);
  };
  $("#machine-list").addEventListener("change", async (event) => {
    const host = event.target.dataset.hostName;
    if (!host) return;
    const entry = prefs.hosts.find((h) => h.host === host);
    if (!entry) return;
    const before = entry.name;
    entry.name = event.target.value.trim().slice(0, MAX_HOST_LABEL_LENGTH) || host.slice(0, MAX_HOST_LABEL_LENGTH);
    try {
      await save(true);
      const label = event.target.closest(".machine-row")?.querySelector(".machine-option span");
      if (label) label.textContent = entry.name;
      event.target.value = entry.name === host.slice(0, MAX_HOST_LABEL_LENGTH) ? "" : entry.name;
      renderStatus(context);
      fieldError("#host-error");
    } catch (error) {
      entry.name = before;
      fieldError("#host-error", `Could not rename host: ${error.message}`);
    }
  });
  $("#machine-list").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.hasAttribute("data-all-hosts")) switchHost(null);
    else if (button.dataset.host !== undefined) switchHost(button.dataset.host);
    if (button.dataset.forgetHost) {
      prefs.hosts = prefs.hosts.filter(
        (h) => h.host !== button.dataset.forgetHost,
      );
      await save();
      openMachines();
    }
  });
  $("#empty-state").addEventListener("click", (event) => {
    if (event.target.closest("[data-open-settings]")) openSettings();
    // Offer the same thing the path bar does: a picker for this computer,
    // Settings for anywhere a picker cannot reach.
    if (event.target.closest("[data-choose-folder]")) {
      if (hostFilter() === null) openSettings();
      else $("#path-button").onclick();
    }
  });
  return {
    initialize,
    load,
    reset,
    setTheme,
    renderStatus,
    openSettings,
    openMachines,
    switchHost,
    get theme() {
      return prefs.theme;
    },
    get options() {
      return options();
    },
    get savedRoot() {
      return prefs.scan?.root || "";
    },
  };
}
