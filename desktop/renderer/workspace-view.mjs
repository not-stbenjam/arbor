import { icon, size, sizeOf, ago, fullDate, repoID } from "./presentation.mjs";

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
    for (const id of [
      "refresh-button",
      "machine-button",
      "path-button",
      "settings-save",
    ])
      $(`#${id}`).disabled = disabled;
    $("#scan-options-button").disabled = state.setupRequired;
    $("#reset-preferences").disabled =
      !workspace.connected ||
      workspace.resetting ||
      workspace.removing ||
      (state.busy && !state.canCancelScan && !state.cancelRequested);
    $("#reset-preferences").textContent = workspace.resetting
      ? "Resetting…"
      : "Reset to defaults…";
    $("#settings-save").textContent = workspace.removing
      ? "Cleanup in progress…"
      : state.busy
        ? "Scanning…"
        : "Save & scan";
    $('#host-form button[type="submit"]').disabled = disabled;
    $("#refresh-button").innerHTML =
      `${icon("refresh", state.busy ? "spinning" : "")}<span>${state.busy ? "Scanning" : state.cancelled ? "Scan again" : "Refresh"}</span>`;
    $("#cleanup-button").disabled =
      disabled || !state.revision || !ready.length;
    $("#cleanup-button").innerHTML =
      `${icon(workspace.removing ? "refresh" : "cleanup", workspace.removing ? "spinning" : "")}<span>${workspace.removing ? "Deleting…" : `Delete merged${ready.length ? ` (${ready.length})` : ""}`}</span>`;
    $("#cleanup-button").title =
      `Remove ${ready.length} recommended worktrees on ${machineName()} and reclaim ${size(sizeOf(ready))}. Branches are kept.`;
    document
      .querySelectorAll("[data-delete], [data-folder-delete]")
      .forEach((b) => {
        b.disabled = disabled || !state.revision;
      });
  }
  function scanProgressText() {
    const state = workspace.snapshot;
    const p = state.progress || {};
    if (state.cancelRequested) return "Stopping scan…";
    if (state.cancelled && !state.busy) return "Scan stopped";
    if (workspace.removing && p.stage === "removing")
      return "Removing selected worktrees…";
    return (
      {
        starting: "Starting scan…",
        discovery: "Finding Git repositories…",
        fetch: "Fetching remote branches…",
        inspect: "Inspecting worktrees…",
        connecting: "Connecting to SSH host…",
        removing: "Removing selected worktrees…",
      }[p.stage] || "Scanning workspace…"
    );
  }
  function renderProgress() {
    const state = workspace.snapshot;
    const active = state.busy || state.cancelled;
    $("#scan-progress").hidden = !active;
    document.body.classList.toggle("scan-active", active);
    const p = state.progress || {};
    const stage = scanProgressText();
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
    const totalKnown =
      Number.isFinite(p.total) &&
      p.total > 0 &&
      ["fetch", "inspect"].includes(p.stage);
    const completed = Math.max(0, Number(p.completed) || 0);
    const countText = totalKnown
      ? `${completed} of ${p.total} ${p.stage === "fetch" ? "repositories" : "worktrees"}`
      : Number(p.discovered) > 0
        ? `${p.discovered} discovered`
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
    $("#settings-progress").hidden = !state.busy;
    $("#settings-progress").textContent = state.busy
      ? `${stage}${countText ? ` ${countText}.` : ""} You can edit these settings now. To start another scan, wait for this one to finish or close Settings and use Stop scan in the main window.`
      : "";
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
