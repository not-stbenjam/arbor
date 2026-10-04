import { icon, esc, initializeDOM } from "./presentation.mjs";
import { createPreferencesController } from "./preferences-controller.mjs";
import { createSetupController } from "./setup-controller.mjs";
import { createStatisticsController } from "./statistics-controller.mjs";
import { createWorkspaceController } from "./workspace-controller.mjs";
import { createWorkspaceView } from "./workspace-view.mjs";
import { createWorktreeView } from "./worktree-view.mjs";

// Composition root: connect controllers through commands and read-only accessors.
// Backend state, tree interaction, preferences, and each dialog have separate owners.
const $ = (selector) => document.querySelector(selector);
initializeDOM();
function notify(message, error = false) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.innerHTML = `${icon(error ? "warning" : "check-circle")}<span>${esc(message)}</span><button class="icon-button" aria-label="Dismiss notification">${icon("close")}</button>`;
  el.querySelector("button").onclick = () => el.remove();
  $("#toast-region").append(el);
  setTimeout(() => el.remove(), error ? 12000 : 5500);
}

async function bootstrap() {
  const api = window.arbor;
  if (!api)
    throw new Error(
      "Open Arbor as a desktop app to connect to your workspace.",
    );
  const provided = await api.getDefaults();
  const defaults = { ...provided, excludes: [...provided.excludes] };
  let workspace, setup, trees, chrome, statistics;
  const preferences = createPreferencesController({
    document,
    api,
    defaults,
    notify,
    getWorkspace: () => workspace,
    onSetup: () => setup.open(),
    onReset: () => workspace.reset(),
  });
  workspace = createWorkspaceController({
    api,
    preferences,
    linked: window.ArborTree.linked,
    notify,
    onChange: () => {
      trees?.render();
      chrome?.render();
    },
    onSetup: () => setup.open(),
    onHostChange: () => {
      trees.reset();
      statistics.invalidate();
    },
    onReset: () => {
      document
        .querySelectorAll("dialog[open]")
        .forEach((dialog) => dialog.close());
      trees.reset(true);
      setup.reset();
      statistics.invalidate();
      $("#toast-region").replaceChildren();
    },
  });
  setup = createSetupController({
    document,
    api,
    defaults,
    preferences,
    getWorkspace: () => workspace,
  });
  statistics = createStatisticsController({
    document,
    api,
    getHost: () => workspace.snapshot.host,
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
    tree: window.ArborTree,
    showWorktreeMenu,
  });
  chrome = createWorkspaceView({ document, workspace });
  $("#statistics-button").onclick = statistics.open;
  $("#warning-button").onclick = () => {
    $("#notes-content").innerHTML = (workspace.snapshot.report?.warnings || [])
      .map(
        (message) =>
          `<p class="detail-note warning">${icon("warning")}<span>${esc(message)}</span></p>`,
      )
      .join("");
    $("#notes-dialog").showModal();
  };
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button && !button.disabled && button.dataset.close)
      $(`#${button.dataset.close}`).close();
  });
  function menu(action) {
    if (workspace.resetting) return;
    if (workspace.snapshot.setupRequired) {
      setup.open();
      return;
    }
    if (action && typeof action === "object") {
      if (action.type === "worktree-remove") {
        if (
          !action.revision ||
          action.revision !== workspace.snapshot.revision
        ) {
          notify("The scan changed. Try deleting the worktree again.", true);
          return;
        }
        const row = workspace.items.find((row) => row.id === action.id);
        if (row) workspace.deleteWorktrees([row]);
      }
      return;
    }
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
  trees.render();
  chrome.render();
  await workspace.initialize();
}
bootstrap().catch((error) => {
  $("#error-banner").hidden = false;
  $("#error-message").textContent = error.message;
});
