import { icon, esc } from "./presentation.mjs";

export const readExcludes = (element) =>
  element.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

// Owns persisted preferences, scan choices, machine history, and their editors.
// It never starts a scan implicitly: that decision belongs to WorkspaceController.
export function createPreferencesController({
  document,
  api,
  defaults,
  notify,
  getWorkspace,
  onSetup,
  onReset,
}) {
  const $ = (selector) => document.querySelector(selector);
  let prefs = {
    hosts: [],
    roots: [],
    theme: "system",
    scan: {},
    setupCompleted: false,
  };
  let options = {
    github: false,
    fetch: false,
    excludes: [...defaults.excludes],
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
  function syncOptions(next) {
    if (!next) return;
    options = {
      github: !!next.github,
      fetch: !!next.fetch,
      excludes: [...(next.excludes || options.excludes)],
    };
  }
  function initialize(saved, initial = {}) {
    prefs = { ...prefs, ...saved };
    prefs.hosts = Array.isArray(prefs.hosts)
      ? prefs.hosts.filter((h) => h && typeof h.host === "string")
      : [];
    prefs.roots = Array.isArray(prefs.roots) ? prefs.roots : [];
    if (!["system", "light", "dark"].includes(prefs.theme))
      prefs.theme = "system";
    syncOptions({
      github:
        initial.options?.github ?? prefs.scan?.github ?? initial.report?.github,
      fetch:
        initial.options?.fetch ?? prefs.scan?.fetch ?? initial.report?.fetched,
      excludes:
        initial.options?.excludes || prefs.scan?.excludes || defaults.excludes,
    });
    applyTheme();
  }
  async function save(strict = false) {
    try {
      await api.savePreferences(prefs);
    } catch (error) {
      if (strict) throw error;
      notify(`Could not save settings: ${error.message}`, true);
    }
  }
  function recordScan(next, addHost = false) {
    syncOptions(next);
    prefs.scan = { ...next };
    if (next.host) {
      const host = prefs.hosts.find((entry) => entry.host === next.host);
      if (host) host.root = next.root;
      else if (addHost)
        prefs.hosts.push({ name: next.host, host: next.host, root: next.root });
    } else if (next.root)
      prefs.roots = [
        next.root,
        ...prefs.roots.filter((root) => root !== next.root),
      ].slice(0, 8);
  }
  function openSettings() {
    const state = getWorkspace().snapshot;
    if (state.setupRequired) {
      onSetup();
      return;
    }
    $("#scan-root").value = state.root || "~";
    $("#scan-github").checked = options.github;
    $("#scan-fetch").checked = options.fetch;
    $("#scan-excludes").value = options.excludes.join("\n");
    $("#theme-select").value = prefs.theme;
    $("#choose-folder").hidden = !!state.host;
    $("#root-help").textContent = state.host
      ? `Search folder on ${state.host}. Use ~ for your remote home folder.`
      : "Discover Git repositories and registered worktrees in this folder.";
    if (!$("#settings-dialog").open) $("#settings-dialog").showModal();
  }
  function openMachines() {
    const workspace = getWorkspace(),
      state = workspace.snapshot;
    if (workspace.blocked) return;
    $("#machine-list").innerHTML = [
      { host: "", name: "This computer" },
      ...prefs.hosts,
    ]
      .map(
        (h) =>
          `<div class="machine-row"><button class="machine-option${h.host === state.host ? " active" : ""}" data-host="${esc(h.host)}">${icon(h.host ? "server" : "monitor")}<span>${esc(h.name || h.host)}</span>${h.host === state.host ? icon("check") : ""}</button>${h.host ? `<button class="icon-button" data-forget-host="${esc(h.host)}" title="Forget saved host" aria-label="Forget ${esc(h.host)}">${icon("close")}</button>` : ""}</div>`,
      )
      .join("");
    if (!$("#machine-dialog").open) $("#machine-dialog").showModal();
  }
  function switchHost(host) {
    $("#machine-dialog").close();
    if (host === getWorkspace().snapshot.host) return;
    const root = host
      ? prefs.hosts.find((h) => h.host === host)?.root || "~"
      : prefs.roots[0] || "";
    return getWorkspace().scan(
      { root, host, ...options, excludes: [...options.excludes] },
      true,
    );
  }
  function reset(saved, state) {
    initialize(saved, state);
    $("#settings-form").reset();
    $("#host-form").reset();
    $("#scan-excludes").value = options.excludes.join("\n");
    $("#scan-root").value = state.root || prefs.scan?.root || "~";
    $("#scan-github").checked = options.github;
    $("#scan-fetch").checked = options.fetch;
  }
  $("#settings-button").onclick = openSettings;
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
    if (getWorkspace().snapshot.host) {
      openSettings();
      return;
    }
    try {
      const root = await api.chooseFolder();
      if (root) getWorkspace().scan({ root, host: "", ...options });
    } catch (error) {
      notify(error.message, true);
    }
  };
  $("#settings-form").onsubmit = async (event) => {
    event.preventDefault();
    if (getWorkspace().blocked) return;
    setTheme($("#theme-select").value);
    await save();
    $("#settings-dialog").close();
    return getWorkspace().scan({
      root: $("#scan-root").value.trim(),
      host: getWorkspace().snapshot.host,
      github: $("#scan-github").checked,
      fetch: $("#scan-fetch").checked,
      excludes: readExcludes($("#scan-excludes")),
    });
  };
  $("#host-form").onsubmit = async (event) => {
    event.preventDefault();
    const host = $("#host-input").value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(host)) {
      notify(
        "Enter an SSH alias or user@hostname without spaces or options.",
        true,
      );
      return;
    }
    if (!prefs.hosts.some((h) => h.host === host))
      prefs.hosts.push({ name: host, host, root: "~" });
    await save();
    $("#host-input").value = "";
    return switchHost(host);
  };
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.host !== undefined) switchHost(button.dataset.host);
    if (button.dataset.forgetHost) {
      prefs.hosts = prefs.hosts.filter(
        (h) => h.host !== button.dataset.forgetHost,
      );
      save();
      openMachines();
    }
    if (button.hasAttribute("data-open-settings")) openSettings();
  });
  return {
    initialize,
    syncOptions,
    recordScan,
    save,
    reset,
    setTheme,
    openSettings,
    openMachines,
    switchHost,
    get theme() {
      return prefs.theme;
    },
    get options() {
      return { ...options, excludes: [...options.excludes] };
    },
    get savedRoot() {
      return prefs.scan?.root || "";
    },
    completeSetup() {
      prefs.setupCompleted = true;
    },
  };
}
