import {
  icon,
  size,
  sizeOf,
  ago,
  fullDate,
  repoID,
  sentenceCase,
  viewHost,
} from "./presentation.mjs";
import { hostProgress } from "./host-progress.mjs";
import { recommendedShown, cleanupScope } from "./cleanup-controller.mjs";

// The window's name. Arbor is alpha software and says so in its title.
export const APP_TITLE = "Arbor (Alpha)";

// Workspace chrome: progress, operation controls, footer and errors. It keeps
// no state of its own. `shown` reports what the worktree list currently
// displays, and `onCleanup` opens the review of what Delete recommended
// would delete.
export function createWorkspaceView({
  document,
  workspace,
  shown = () => ({ filtered: workspace.items, filtering: false }),
  onCleanup = () => {},
}) {
  const $ = (selector) => document.querySelector(selector);
  const items = () => workspace.items;
  const blocked = () => workspace.blocked;
  // Read by screen readers when it changes; never drawn.
  let announced = "";
  function announce(message) {
    if (message === announced) return;
    announced = message;
    $("#announcement").textContent = message;
  }
  const plural = (count, noun) => `${count} ${count === 1 ? noun : `${noun}s`}`;
  function renderControls() {
    const state = workspace.snapshot;
    const disabled = blocked(),
      ready = recommendedShown(shown),
      count = plural(ready.length, "worktree"),
      button = $("#cleanup-button");
    $("#refresh-button").disabled = disabled;
    const refresh = state.cancelled ? "Scan again" : "Refresh";
    $("#refresh-button").innerHTML =
      `${icon("refresh", state.busy ? "spinning" : "")}<span>${refresh}</span>`;
    // In a narrow window the button is its icon alone, and still has a name.
    $("#refresh-button").setAttribute("aria-label", refresh);
    button.disabled = disabled || !state.revision || !ready.length;
    // A running operation is not an unavailable one; it stays fully legible.
    button.setAttribute("aria-busy", String(workspace.removing));
    // Both labels are laid out and one is shown, so the button keeps the
    // width of the longer and nothing beside it moves when a deletion starts.
    // The ellipsis says it asks first: it opens the list of what would go.
    const labels = {
      idle: `Delete recommended${ready.length ? ` (${ready.length})` : ""}…`,
      busy: "Deleting…",
    };
    const current = workspace.removing ? "busy" : "idle";
    // Each carries its own icon, so icon and words stay centred together.
    button.innerHTML = `<span class="cleanup-labels">${Object.entries(labels)
      .map(
        ([name, label]) =>
          `<span class="cleanup-label" data-current="${name === current}">${name === "busy" ? icon("refresh", name === current ? "spinning" : "") : icon("trash")}<span>${label}</span></span>`,
      )
      .join("")}</span>`;
    button.title = `Delete the ${count} recommended ${cleanupScope(workspace, shown)}, about ${size(sizeOf(ready))}: the rows marked Merged. Shows each one, and why it is recommended, before deleting anything.`;
    renderStatus();
  }
  // The status bar counts what is listed.
  function renderStatus() {
    const state = workspace.snapshot,
      list = items(),
      repos = new Set(list.map(repoID)),
      activeHosts = state.hosts.filter((source) => source.busy).length;
    // Totals from the hosts that answered are not totals for all of them.
    const failed = state.hosts.filter((source) => source.error && !source.busy),
      away = failed.filter((source) => source.host).length;
    // This computer is never a host that is unavailable: its folder was not
    // scanned, and the list says why.
    const unavailable = [
      away ? `${plural(away, "host")} unavailable` : "",
      failed.length > away ? "this computer not scanned" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const detail = activeHosts
      ? `${activeHosts === 1 ? "scan" : `${activeHosts} scans`} in progress`
      : `${repos.size} ${repos.size === 1 ? "repository" : "repositories"}`;
    $("#status-message").textContent = state.setupRequired
      ? "Choose a folder to scan to get started"
      : workspace.removing
        ? "Deleting worktrees…"
        : `${plural(list.length, "worktree")} · ${detail}${state.hostFilter === null && unavailable ? ` · ${unavailable}` : ""}`;
    $("#status-message").title = $("#status-message").textContent;
  }
  let progressMarkup = "",
    progressSummary = "";
  function renderProgress() {
    const state = workspace.snapshot;
    const hostList = $("#host-progress-list");
    const progress = hostProgress(state.hosts);
    $("#scan-progress").hidden = !progress.visible;
    document.body.classList.toggle("scan-active", progress.visible);
    hostList.hidden = false;
    if (progress.markup !== progressMarkup) {
      // Progress arrives several times a second. Replacing the rows drops
      // keyboard focus from a Stop button, so put it back where it was, or
      // on the next thing to do once that scan has ended.
      const stopping = document.activeElement?.dataset?.stopHost;
      progressMarkup = progress.markup;
      hostList.innerHTML = progress.markup;
      if (stopping !== undefined) {
        const again = hostList.querySelector(
          `[data-stop-host="${CSS.escape(stopping)}"]`,
        );
        (again && !again.disabled ? again : $("#refresh-button")).focus({
          preventScroll: true,
        });
      }
    }
    // Each host row says what it is doing and has its own Stop. A heading
    // earns its line only when there are several to stop at once. When the
    // last but one finishes, whoever was on Stop all moves to the Stop left.
    const stoppingAll =
      !progress.canCancelAll && document.activeElement === $("#stop-scan");
    $("#progress-heading").hidden = !progress.canCancelAll;
    $("#progress-stage").textContent = `Scanning ${progress.active} hosts`;
    $("#stop-scan").disabled = !progress.canCancelAll;
    if (stoppingAll)
      (
        hostList.querySelector("[data-stop-host]:not(:disabled)") ||
        $("#refresh-button")
      ).focus({ preventScroll: true });
    // Say each change of stage once: not every path, and not every redraw.
    if (progress.summary !== progressSummary) {
      if (progress.summary || progressSummary)
        announce(progress.summary || "Finished.");
      progressSummary = progress.summary;
    }
  }
  function render() {
    const state = workspace.snapshot,
      list = items();
    // macOS draws this in the window's own bar; elsewhere the system title
    // bar shows the document title.
    // The name carries the stage the app is at, wherever the name is shown.
    const context =
      viewHost(state) === null
        ? `All hosts — ${APP_TITLE}`
        : state.host
          ? `${state.host} — ${APP_TITLE}`
          : APP_TITLE;
    $("#window-context").textContent = context;
    document.title = context;
    $("#version").textContent = state.version ? `Arbor ${state.version}` : "";
    document.body.classList.toggle(
      "platform-darwin",
      state.platform === "darwin",
    );
    document.body.classList.toggle(
      "platform-linux",
      state.platform !== "darwin",
    );
    $("#search-shortcut").textContent =
      state.platform === "darwin" ? "⌘F" : "Ctrl F";
    $("#settings-shortcut").textContent =
      state.platform === "darwin" ? "⌘," : "Ctrl ,";
    const warnings = state.report?.warnings || [];
    $("#warning-button").hidden = !warnings.length;
    $("#warning-button").textContent =
      `${warnings.length} scan ${warnings.length === 1 ? "warning" : "warnings"}`;
    $("#warning-button").title =
      "Some folders or repositories could not be checked. Show details.";
    $("#space-label").textContent = state.report
      ? `${size(sizeOf(list))} on disk`
      : "";
    $("#scan-time").textContent = state.report
      ? state.cached
        ? `Saved results from ${ago(state.report.scannedAt).toLowerCase()}`
        : `Scanned ${ago(state.report.scannedAt).toLowerCase()}`
      : "";
    $("#scan-time").title = state.report
      ? `${state.cached ? "Shown from the last scan without rescanning. Refresh to update. " : ""}${fullDate(state.report.scannedAt)}`
      : "";

    const error = workspace.error,
      message = error || workspace.warning || "",
      kind = error ? "error" : "warning";
    $("#error-banner").hidden = !message;
    $("#error-banner").dataset.kind = kind;
    $("#error-banner").setAttribute("role", error ? "alert" : "status");
    // An alert is read out when it is written, so one that has not changed
    // is not written again each time the list is drawn.
    const said = sentenceCase(message);
    if ($("#error-message").textContent !== said)
      $("#error-message").textContent = said;
    $("#dismiss-error").setAttribute("aria-label", `Dismiss ${kind}`);
    renderProgress();
    renderControls();
  }
  $("#stop-scan").onclick = () => workspace.cancel(null);
  $("#host-progress-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-stop-host]");
    if (button && !button.disabled) workspace.cancel(button.dataset.stopHost);
    const halt = event.target.closest("[data-stop-removal]");
    if (halt && !halt.disabled) workspace.stopRemoval();
  });
  $("#refresh-button").onclick = workspace.refresh;
  $("#cleanup-button").onclick = () => onCleanup();
  // A held Enter repeats the press. Once the review it opened is closed
  // again, the repeats must not open it again.
  $("#cleanup-button").addEventListener("keydown", (event) => {
    if (event.repeat && event.key === "Enter") event.preventDefault();
  });
  $("#dismiss-error").onclick = workspace.dismissError;
  return { render, renderControls };
}
