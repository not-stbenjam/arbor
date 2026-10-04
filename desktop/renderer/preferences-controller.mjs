import { icon, esc } from "./presentation.mjs";
import {
  isValidSSHHost,
  MAX_HOST_LENGTH,
  MAX_HOST_LABEL_LENGTH,
} from "../common/ssh-host.mjs";
import { readExcludes } from "./input-values.mjs";

// Owns preference editors and the last canonical preferences read from main.
// Scan requests are emitted as commands; only main persists active scan choices.
export function createPreferencesController({
  document,
  api,
  defaults,
  notify,
  onScan,
  onHostChange,
  onSetup,
  onReset,
}) {
  const $ = (selector) => document.querySelector(selector);
  $("#host-input").maxLength = MAX_HOST_LENGTH;
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
  const hostFilter = () => context.hostFilter;
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
    };
  };
  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
    $("#theme-select").value = prefs.theme;
    $("#theme-button").innerHTML = icon(
      prefs.theme === "dark" ? "moon" : "sun",
    );
    $("#theme-button").title = `Appearance: ${prefs.theme}. Click to change.`;
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
    const path =
      selected === null
        ? "All configured hosts"
        : `${selected ? `${selected}:` : ""}${context.root || "Home folder"}`;
    $("#machine-label").textContent = machine;
    $("#machine-label").title = machine;
    const kind = selected === "" ? "monitor" : "server";
    $("#machine-icon").innerHTML = icon(kind);
    $("#machine-icon").dataset.kind = kind;
    $("#root-label").textContent = path;
    $("#path-button").title = `Scan folder: ${path}`;
    $("#machine-button").disabled = context.blocked;
    $("#path-button").disabled = context.blocked;
    const editingState = context.hosts.find(
      (source) => source.host === editingHost,
    );
    $("#settings-save").disabled = context.blocked || !!editingState?.busy;
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
        : "Save & scan";
    $('#host-form button[type="submit"]').disabled = context.blocked;
    $("#settings-progress").hidden = !editingState?.busy;
    $("#settings-progress").textContent = editingState?.busy
      ? `${hostName(editingHost)} is scanning in the background. Stop its scan in the main window to apply new scan options.`
      : "";
  }
  function editHost(host) {
    editingHost = host;
    const source = context.hosts.find((entry) => entry.host === host);
    const scan = source?.options || options();
    $("#scan-root").value =
      source?.root ||
      (host
        ? prefs.hosts.find((entry) => entry.host === host)?.root
        : prefs.roots[0]) ||
      "~";
    $("#scan-github").checked = !!scan.github;
    $("#scan-fetch").checked = !!scan.fetch;
    $("#scan-excludes").value = (scan.excludes || defaults.excludes).join("\n");
    $("#choose-folder").hidden = !!host;
    $("#root-help").textContent = host
      ? `Search folder on ${host}. Use ~ for your remote home folder.`
      : "Discover Git repositories and registered worktrees in this folder.";
    renderStatus(context);
  }
  function openSettings() {
    if (context.setupRequired) {
      onSetup();
      return;
    }
    $("#settings-host").innerHTML = machines()
      .map(
        (entry) =>
          `<option value="${esc(entry.host)}">${esc(entry.name || entry.host)}</option>`,
      )
      .join("");
    $("#settings-host").value = hostFilter() || "";
    editHost($("#settings-host").value);
    $("#theme-select").value = prefs.theme;
    if (!$("#settings-dialog").open) $("#settings-dialog").showModal();
  }
  function openMachines() {
    if (context.blocked) return;
    $("#machine-list").innerHTML = [
      { host: null, name: "All hosts" },
      ...machines(),
    ]
      .map(
        (h) =>
          `<div class="machine-row"><button class="machine-option${h.host === hostFilter() ? " active" : ""}" ${h.host === null ? "data-all-hosts" : `data-host="${esc(h.host)}"`}>${icon(h.host !== "" ? "server" : "monitor")}<span>${esc(h.name || h.host)}</span>${h.host === hostFilter() ? icon("check") : ""}</button>${h.host && !h.sessionOnly ? `<button class="icon-button" data-forget-host="${esc(h.host)}" title="Forget saved host" aria-label="Forget ${esc(h.host)}">${icon("close")}</button>` : ""}</div>`,
      )
      .join("");
    if (!$("#machine-dialog").open) $("#machine-dialog").showModal();
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
    $("#host-form").reset();
    $("#scan-excludes").value = (
      state.options?.excludes ||
      saved.scan?.excludes ||
      defaults.excludes
    ).join("\n");
    $("#scan-root").value = state.root || saved.scan?.root || "~";
    $("#scan-github").checked = !!saved.scan?.github;
    $("#scan-fetch").checked = !!saved.scan?.fetch;
  }
  $("#settings-button").onclick = openSettings;
  $("#settings-host").onchange = () => editHost($("#settings-host").value);
  $("#scan-options-button").onclick = openSettings;
  $("#machine-button").onclick = openMachines;
  $("#add-host").onclick = () => {
    openMachines();
    $("#host-input").focus();
  };
  $("#scan-reset-excludes").onclick = () => {
    $("#scan-excludes").value = defaults.excludes.join("\n");
  };
  $("#reset-preferences").onclick = () => {
    if (!$("#reset-preferences").disabled) onReset();
  };
  $("#theme-button").onclick = () => {
    setTheme(
      { system: "light", light: "dark", dark: "system" }[prefs.theme] ||
        "system",
    );
    save();
  };
  $("#choose-folder").onclick = async () => {
    try {
      const root = await api.chooseFolder();
      if (root) $("#scan-root").value = root;
    } catch (error) {
      notify(error.message, true);
    }
  };
  $("#path-button").onclick = async () => {
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
  $("#settings-form").onsubmit = (event) => {
    event.preventDefault();
    if ($("#settings-save").disabled) return;
    setTheme($("#theme-select").value);
    $("#settings-dialog").close();
    return onScan({
      root: $("#scan-root").value.trim(),
      host: editingHost,
      github: $("#scan-github").checked,
      fetch: $("#scan-fetch").checked,
      excludes: readExcludes($("#scan-excludes")),
      theme: prefs.theme,
    });
  };
  $("#host-form").onsubmit = async (event) => {
    event.preventDefault();
    const host = $("#host-input").value.trim();
    if (!isValidSSHHost(host)) {
      notify(
        `Enter an SSH alias or user@hostname, up to ${MAX_HOST_LENGTH} characters, without spaces or options.`,
        true,
      );
      return;
    }
    if (!prefs.hosts.some((h) => h.host === host))
      prefs.hosts.push({
        name: host.slice(0, MAX_HOST_LABEL_LENGTH),
        host,
        root: "~",
      });
    try {
      await save(true);
    } catch (error) {
      notify(`Could not save settings: ${error.message}`, true);
      return;
    }
    $("#host-input").value = "";
    return switchHost(host);
  };
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
