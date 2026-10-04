import {
  icon,
  size,
  sizeOf,
  ago,
  fullDate,
  repoID,
  describeProgress,
} from "./presentation.mjs";

// Stateless workspace chrome: progress, operation controls, footer and errors.
export function createWorkspaceView({ document, workspace }) {
  const $ = (selector) => document.querySelector(selector);
  const items = () => workspace.items;
  const blocked = () => workspace.blocked;
  const machineName = () => workspace.snapshot.host || "This computer";
  function renderControls() {
    const state = workspace.snapshot;
    const disabled = blocked(),
      ready = items().filter((w) => w.recommended);
    $("#refresh-button").disabled = disabled;
    $("#refresh-button").innerHTML =
      `${icon("refresh", state.busy ? "spinning" : "")}<span>${state.busy ? "Scanning" : state.cancelled ? "Scan again" : "Refresh"}</span>`;
    $("#cleanup-button").disabled =
      disabled || !state.revision || !ready.length;
    $("#cleanup-button").innerHTML =
      `${icon(workspace.removing ? "refresh" : "cleanup", workspace.removing ? "spinning" : "")}<span>${workspace.removing ? "Deleting…" : `Delete merged${ready.length ? ` (${ready.length})` : ""}`}</span>`;
    $("#cleanup-button").title =
      `Remove ${ready.length} recommended worktrees on ${machineName()} and reclaim ${size(sizeOf(ready))}. Branches are kept.`;
  }
  function renderProgress() {
    const state = workspace.snapshot;
    const active = state.busy || state.cancelled;
    $("#scan-progress").hidden = !active;
    document.body.classList.toggle("scan-active", active);
    const p = state.progress || {};
    const { stage, totalKnown, completed, countText } = describeProgress(
      state,
      workspace.removing,
    );
    $("#progress-stage").textContent = stage;
    const currentPath = p.path || state.root || "";
    $("#progress-path").textContent =
      state.cancelled && !state.busy
        ? `${items().length} ${items().length === 1 ? "worktree" : "worktrees"} found. Scan again to finish checks; cleanup stays disabled.`
        : currentPath;
    $("#progress-path").title = currentPath;
    const elapsed = Number.isFinite(p.startedAt)
      ? Math.max(0, Math.floor((Date.now() - p.startedAt) / 1000))
      : 0;
    $("#progress-elapsed").textContent =
      state.busy && p.startedAt
        ? elapsed < 60
          ? `${elapsed}s elapsed`
          : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`
        : "";
    $("#progress-counts").textContent =
      state.cancelled && !state.busy ? "" : countText;
    const meter = $("#progress-meter");
    meter.hidden = !state.busy;
    if (totalKnown) {
      meter.max = p.total;
      meter.value = Math.min(completed, p.total);
    } else meter.removeAttribute("value");
    meter.setAttribute(
      "aria-label",
      totalKnown
        ? `${completed} of ${p.total} ${p.stage === "fetch" ? "repositories fetched" : "worktrees inspected"}`
        : stage,
    );
    $("#stop-scan").hidden =
      !state.busy || (!state.canCancelScan && !state.cancelRequested);
    $("#stop-scan").disabled = !!state.cancelRequested;
    $("#stop-scan").textContent = state.cancelRequested
      ? "Stopping…"
      : "Stop scan";
  }
  function render() {
    const state = workspace.snapshot,
      list = items(),
      repos = new Set(list.map(repoID));
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
    $("#status-message").textContent = state.setupRequired
      ? "Choose a workspace to get started"
      : workspace.removing
        ? "Removing worktrees…"
        : state.busy
          ? state.host
            ? `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} found · scanning remote workspace…`
            : `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} found · scanning…`
          : state.cancelled
            ? `Scan stopped · ${list.length} ${list.length === 1 ? "worktree" : "worktrees"} found · scan again to finish checks`
            : `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} · ${repos.size} ${repos.size === 1 ? "repository" : "repositories"}`;
    const warnings = state.report?.warnings || [];
    $("#warning-button").hidden = !warnings.length;
    $("#warning-button").textContent =
      `${warnings.length} ${warnings.length === 1 ? "note" : "notes"}`;
    $("#space-label").textContent = state.report
      ? `${size(sizeOf(list))} on disk`
      : "";
    $("#scan-time").textContent = state.report
      ? `${state.cached ? "Saved scan" : "Scanned"} ${ago(state.report.scannedAt).toLowerCase()}`
      : "";
    $("#scan-time").title = state.report
      ? `${fullDate(state.report.scannedAt)} · ${state.report.durationMs} ms`
      : "";

    $("#error-banner").hidden = !workspace.error;
    $("#error-message").textContent = workspace.error;
    renderProgress();
    renderControls();
  }
  $("#stop-scan").onclick = workspace.cancel;
  $("#refresh-button").onclick = workspace.refresh;
  $("#cleanup-button").onclick = () =>
    workspace.remove(
      items().filter((w) => w.recommended),
      true,
    );
  $("#dismiss-error").onclick = workspace.dismissError;
  return { render };
}
