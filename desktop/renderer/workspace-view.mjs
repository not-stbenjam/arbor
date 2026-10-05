import { icon, size, sizeOf, ago, fullDate, repoID } from "./presentation.mjs";
import { hostProgress } from "./host-progress.mjs";

// How long Delete recommended stays armed, waiting for its confirming click.
const CONFIRM_WINDOW = 5000;

// Workspace chrome: progress, operation controls, footer and errors. Its only
// state is whether Delete recommended is waiting for its confirming click.
// `shown` reports what the worktree list currently displays.
export function createWorkspaceView({
  document,
  workspace,
  shown = () => ({ filtered: workspace.items, filtering: false }),
  timers = globalThis,
}) {
  const $ = (selector) => document.querySelector(selector);
  const items = () => workspace.items;
  const blocked = () => workspace.blocked;
  // One click removes exactly the recommendations the list shows. Repository
  // and search filters narrow it, just as they narrow a folder's Delete.
  const recommended = () => shown().filtered.filter((w) => w.recommended);
  const hostName = () =>
    workspace.snapshot.hostFilter === null
      ? "all hosts"
      : workspace.snapshot.host || "this computer";
  // Delete recommended has no dialog: what it removes is safe to remove and easy
  // to recreate. It sits beside Refresh, though, so one stray click must not
  // delete folders. The first click arms the button, which then says exactly
  // what it will do; the second, within a few seconds, does it.
  let armed = null;
  const selectionKey = (rows) => rows.map((row) => row.id).join("\n");
  function disarm() {
    if (!armed) return;
    timers.clearTimeout(armed.timer);
    armed = null;
  }
  function renderControls() {
    const state = workspace.snapshot;
    const disabled = blocked(),
      ready = recommended(),
      count = `${ready.length} ${ready.length === 1 ? "worktree" : "worktrees"}`,
      button = $("#cleanup-button");
    $("#refresh-button").disabled = disabled;
    $("#refresh-button").innerHTML =
      `${icon("refresh", state.busy ? "spinning" : "")}<span>${state.cancelled ? "Scan again" : "Refresh"}</span>`;
    // Consent is for the rows it was given for, and only while they can go.
    if (armed && (disabled || armed.key !== selectionKey(ready))) disarm();
    button.disabled = disabled || !state.revision || !ready.length;
    button.classList.toggle("armed", !!armed);
    // A running operation is not an unavailable one; it stays fully legible.
    button.setAttribute("aria-busy", String(workspace.removing));
    button.innerHTML = `${icon(workspace.removing ? "refresh" : "trash", workspace.removing ? "spinning" : "")}<span>${
      workspace.removing
        ? "Deleting…"
        : armed
          ? `Confirm: delete ${count}`
          : `Delete recommended${ready.length ? ` (${ready.length})` : ""}`
    }</span>`;
    const scope = shown().filtering ? "shown in this view" : `on ${hostName()}`;
    button.title = armed
      ? `Click again to delete ${count} ${scope}, about ${size(sizeOf(ready))}. Branches and commits are kept.`
      : `Delete the ${count} recommended ${scope}, about ${size(sizeOf(ready))}: the rows marked Merged. Branches and commits are kept. Asks once before deleting.`;
  }
  function renderProgress() {
    const state = workspace.snapshot;
    const hostList = $("#host-progress-list");
    const progress = hostProgress(state.hosts);
    $("#scan-progress").hidden = !progress.visible;
    document.body.classList.toggle("scan-active", progress.visible);
    hostList.hidden = false;
    hostList.innerHTML = progress.markup;
    // Each host row says what it is doing and has its own Stop. A heading
    // earns its line only when there are several to stop at once.
    $("#progress-heading").hidden = !progress.canCancelAll;
    $("#progress-stage").textContent = `Scanning ${progress.active} hosts`;
    $("#stop-scan").disabled = !progress.canCancelAll;
  }
  function render() {
    const state = workspace.snapshot,
      list = items(),
      repos = new Set(list.map(repoID)),
      activeHosts = state.hosts.filter((source) => source.busy).length;
    // macOS draws this in the window's own bar; elsewhere the system title
    // bar shows the document title.
    const context =
      state.hostFilter === null
        ? "All hosts — Arbor"
        : state.host
          ? `${state.host} — Arbor`
          : "Arbor";
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
    // Totals from the hosts that answered are not totals for all of them.
    const unavailable = state.hosts.filter(
      (source) => source.error && !source.busy,
    ).length;
    const summary = `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} · ${
      activeHosts
        ? `${activeHosts === 1 ? "scan" : `${activeHosts} scans`} in progress`
        : `${repos.size} ${repos.size === 1 ? "repository" : "repositories"}`
    }${state.hostFilter === null && unavailable ? ` · ${unavailable} ${unavailable === 1 ? "host" : "hosts"} unavailable` : ""}`;
    $("#status-message").textContent = state.setupRequired
      ? "Choose a folder to scan to get started"
      : workspace.removing
        ? "Deleting worktrees…"
        : shown().selectedCount === 1
          ? // The bulk controls appear with a second row; say how to get one.
            `1 selected · Shift-click for a range, ${state.platform === "darwin" ? "⌘" : "Ctrl"}-click to add, Delete to remove`
          : summary;
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
    // The command line's messages start in lower case. A line that opens
    // with a plain word becomes a sentence; one that opens with a host's
    // name, which ends in a colon, is left exactly as the host is spelled.
    $("#error-message").textContent = message.replace(
      /(^|\n)(\p{Ll})(?=\p{L}*\s)/gu,
      (_, start, letter) => start + letter.toUpperCase(),
    );
    $("#dismiss-error").setAttribute("aria-label", `Dismiss ${kind}`);
    renderProgress();
    renderControls();
  }
  $("#stop-scan").onclick = () => workspace.cancel(null);
  $("#host-progress-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-stop-host]");
    if (button && !button.disabled) workspace.cancel(button.dataset.stopHost);
  });
  $("#refresh-button").onclick = workspace.refresh;
  $("#cleanup-button").onclick = () => {
    const ready = recommended();
    if (!ready.length) return;
    if (armed?.key === selectionKey(ready)) {
      disarm();
      renderControls();
      return workspace.remove(ready, true);
    }
    disarm();
    armed = {
      key: selectionKey(ready),
      timer: timers.setTimeout(() => {
        armed = null;
        renderControls();
      }, CONFIRM_WINDOW),
    };
    renderControls();
  };
  // Looking away withdraws the question, as closing a dialog would.
  $("#cleanup-button").addEventListener("blur", () => {
    disarm();
    renderControls();
  });
  $("#dismiss-error").onclick = workspace.dismissError;
  return { render, renderControls };
}
