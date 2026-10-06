import { createFilesController } from "./files-controller.mjs";
import * as tree from "../common/worktree-tree.mjs";
import { icon, esc, initializeDOM, viewHost } from "./presentation.mjs";
import { createCleanupController } from "./cleanup-controller.mjs";
import { createPreferencesController } from "./preferences-controller.mjs";
import { createSetupController } from "./setup-controller.mjs";
import { createStatisticsController } from "./statistics-controller.mjs";
import { createWorkspaceController } from "./workspace-controller.mjs";
import { createWorkspaceView } from "./workspace-view.mjs";
import { createWorktreeView } from "./worktree-view.mjs";

// Composition root: connect controllers through commands and read-only accessors.
// Backend state, tree interaction, preferences, and each dialog have separate owners.
const $ = (selector) => document.querySelector(selector);
document.body.classList.toggle(
  "platform-darwin",
  window.arbor?.platform === "darwin",
);
initializeDOM();
function notify(message, error = false) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.innerHTML = `${icon(error ? "warning" : "check-circle")}<span>${esc(message)}</span><button class="icon-button" aria-label="Dismiss notification">${icon("close")}</button>`;
  el.querySelector("button").onclick = () => el.remove();
  $("#toast-region").append(el);
  // It leaves on its own, but not while someone is reading or reaching for
  // it: the pointer and the keyboard each hold it, and one letting go does
  // not release the other.
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    // Focus has not arrived at its destination when focusout fires.
    queueMicrotask(() => {
      if (el.matches(":hover") || el.contains(document.activeElement)) return;
      clearTimeout(timer);
      timer = setTimeout(() => el.remove(), error ? 12000 : 5500);
    });
  };
  for (const type of ["mouseenter", "focusin"])
    el.addEventListener(type, () => clearTimeout(timer));
  for (const type of ["mouseleave", "focusout"])
    el.addEventListener(type, schedule);
  schedule();
}

async function bootstrap() {
  const api = window.arbor;
  if (!api)
    throw new Error(
      "Open Arbor as a desktop app to connect to your workspace.",
    );
  const provided = await api.getDefaults();
  const defaults = { ...provided, excludes: [...provided.excludes] };
  let workspace, setup, trees, chrome, cleanup, statistics;
  const preferences = createPreferencesController({
    document,
    api,
    defaults,
    notify,
    onScan: (options) => workspace.scan(options),
    onStopScan: (host) => workspace.cancel(host),
    onHostChange: (host) => workspace.setHostFilter(host),
    onSetup: () => setup.open(),
    onReset: () => workspace.reset(),
  });
  workspace = createWorkspaceController({
    api,
    linked: tree.linked,
    notify,
    onChange: () => {
      try {
        render();
      } catch (error) {
        // One unrenderable snapshot must not blank the window or end polling.
        $("#error-banner").hidden = false;
        $("#error-message").textContent =
          `Arbor could not display this workspace: ${error.message}. Refresh to scan again.`;
      }
    },
    onSetup: () => setup.open(),
    onHostChange: () => {
      trees.reset();
      statistics.invalidate();
    },
    onReset: (result) => {
      document
        .querySelectorAll("dialog[open]")
        .forEach((dialog) => dialog.close());
      trees.reset(true);
      setup.reset();
      preferences.reset(result.preferences, result.state);
      statistics.invalidate();
      $("#toast-region").replaceChildren();
    },
    onScanAccepted: async () => {
      try {
        await preferences.load();
      } catch (error) {
        notify(`Could not reload settings: ${error.message}`, true);
      }
    },
  });
  function render() {
    const state = workspace.snapshot;
    preferences.renderStatus({
      root: state.root,
      host: state.host,
      hostFilter: state.hostFilter,
      hosts: state.hosts,
      options: state.options,
      setupRequired: state.setupRequired,
      busy: state.busy,
      progress: state.progress,
      canCancelScan: state.canCancelScan,
      cancelRequested: state.cancelRequested,
      connected: workspace.connected,
      resetting: workspace.resetting,
      removing: workspace.removing,
      blocked: workspace.blocked,
    });
    setup?.setContext({
      required: state.setupRequired,
      root: state.root || preferences.savedRoot,
      resetting: workspace.resetting,
      theme: preferences.theme,
      excludes: preferences.options.excludes,
    });
    // The list reports each projection to the chrome, which draws around it.
    if (trees) trees.render();
    else chrome?.render();
  }
  setup = createSetupController({
    document,
    api,
    defaults,
    onSubmit: (options) => workspace.completeSetup(options),
    onComplete: () => trees.focusGrid(),
    onThemeChange: (theme) => preferences.setTheme(theme),
  });
  statistics = createStatisticsController({
    document,
    api,
    getHost: () => viewHost(workspace.snapshot) ?? null,
  });
  const showWorktreeMenu = async (id) => {
    if (!workspace.items.some((row) => row.id === id)) return;
    try {
      await api.showWorktreeMenu({ id, revision: workspace.snapshot.revision });
    } catch (error) {
      notify(error.message, true);
    }
  };
  trees = createWorktreeView({
    document,
    workspace,
    tree,
    showWorktreeMenu,
    onSortChange: (value) =>
      api.saveView?.(value)?.catch((error) =>
        notify(`Could not save view: ${error.message}`, true),
      ),
    reviewDeletion: (rows) => cleanup.openFor(rows),
    // Filtering changes what Delete recommended acts on, and so its count
    // and what an open review of it can still delete.
    onRender: () => {
      chrome?.render();
      cleanup?.render();
    },
  });
  const files = createFilesController({ document, api, workspace });
  cleanup = createCleanupController({
    onShowFiles: (row) => files.open(row),
    document,
    workspace,
    shown: () => trees,
    onDeleting: () => trees.focus(),
  });
  chrome = createWorkspaceView({
    document,
    workspace,
    shown: () => trees,
    onCleanup: cleanup.open,
  });
  $("#statistics-button").onclick = statistics.open;
  // What the keyboard does in the list, which nothing on screen says.
  const mod = api.platform === "darwin" ? "⌘" : "Ctrl+";
  const SHORTCUTS = [
    ["↑ ↓ Home End Page Up Page Down", "Move through the list, ticking nothing"],
    ["Space", "Tick or untick the row"],
    ["Shift+↑ ↓, or Shift+click", "Tick every row from the one the keyboard is on"],
    [`${mod}A`, "Tick everything the list shows"],
    ["Esc", "Untick everything"],
    ["Enter, or right-click", "The row's actions: copy its path, open it, delete it"],
    ["Delete or Backspace", "Delete what is ticked, or the row the keyboard is on. It asks first"],
    ["← →", "Close or open the folder the keyboard is on"],
    [`/ or ${mod}F`, "Filter the list. ↓ goes to the first result"],
    [`${mod}R`, "Refresh"],
    [`${mod},`, "Settings"],
  ];
  function showShortcuts() {
    $("#notes-title").textContent = "Keyboard shortcuts";
    $("#notes-content").innerHTML =
      `<dl class="shortcuts">${SHORTCUTS.map(([keys, does]) => `<dt>${esc(keys)}</dt><dd>${esc(does)}</dd>`).join("")}</dl>`;
    $("#notes-dialog").showModal();
  }
  $("#warning-button").onclick = () => {
    $("#notes-title").textContent = "Scan warnings";
    $("#notes-content").innerHTML =
      `<p class="field-hint">Some checks could not be completed. Nothing else was affected.</p><ul class="scan-warnings">${(
        workspace.snapshot.report?.warnings || []
      )
        .map((message) => `<li>${icon("warning")}<span>${esc(message)}</span></li>`)
        .join("")}</ul>`;
    $("#notes-dialog").showModal();
  };
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.disabled) $(`#${button.dataset.close}`).close();
    });
  });
  // The menu bar offers what the window's own buttons do, and is told when
  // they cannot be used: during setup, behind a dialog, while deleting.
  const usable = (selector) =>
    !document.querySelector("dialog[open]") &&
    !workspace.resetting &&
    !workspace.snapshot.setupRequired &&
    !$(selector).disabled;
  let menuState = "";
  function syncMenu() {
    const commands = {
      refresh: usable("#refresh-button"),
      "add-host": usable("#add-host"),
      statistics: usable("#statistics-button"),
      settings: usable("#settings-button"),
      "focus-search": usable("#search"),
      shortcuts: !document.querySelector("dialog[open]"),
    };
    const next = JSON.stringify(commands);
    if (next === menuState) return;
    menuState = next;
    api.setMenuAvailability?.(commands)?.catch?.(() => {});
  }
  new MutationObserver(syncMenu).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["open", "disabled"],
  });
  syncMenu();
  function menu(action) {
    if (workspace.resetting) return;
    if (workspace.snapshot.setupRequired) {
      setup.open();
      return;
    }
    // A shortcut can arrive before the menu has heard that a dialog opened.
    if (typeof action === "string" && document.querySelector("dialog[open]"))
      return;
    if (action && typeof action === "object") {
      if (action.type === "worktree-files") {
        const row = workspace.items.find((row) => row.id === action.id);
        if (row) void files.open(row, action.revision);
      }
      if (action.type === "worktree-remove") {
        const row = workspace.items.find((row) => row.id === action.id);
        if (row) workspace.deleteWorktrees([row]);
      }
      return;
    }
    if (action === "shortcuts") showShortcuts();
    if (action === "refresh") workspace.refresh();
    if (action === "settings") preferences.openSettings();
    if (action === "statistics") statistics.open();
    if (action === "focus-search") trees.focusSearch();
    if (action === "add-host") {
      preferences.openMachines();
      $("#host-input").focus();
    }
  }
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement.tagName,
      ) &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      menu("focus-search");
    }
  });
  const unsubscribe = api.onMenuAction(menu);
  window.addEventListener(
    "pagehide",
    () => {
      workspace.dispose();
      statistics.invalidate();
      unsubscribe();
    },
    { once: true },
  );
  // Drawing the list draws the chrome around it.
  trees.render();
  await preferences.load();
  trees.restoreSort(await api.getPreferences());
  await workspace.initialize();
}
bootstrap().catch((error) => {
  $("#error-banner").hidden = false;
  $("#error-message").textContent = error.message;
});
