import { icon, size, sizeOf, ago, fullDate, repoID } from "./presentation.mjs";
import { hostProgress } from "./host-progress.mjs";

// Stateless workspace chrome: progress, operation controls, footer and errors.
export function createWorkspaceView({ document, workspace }) {
  const $ = (selector) => document.querySelector(selector);
  const items = () => workspace.items;
  const blocked = () => workspace.blocked;
  const machineName = () =>
    workspace.snapshot.hostFilter === null
      ? "all machines"
      : workspace.snapshot.host || "This computer";
  function renderControls() {
    const state = workspace.snapshot;
    const disabled = blocked(),
      ready = items().filter((w) => w.recommended);
    $("#refresh-button").disabled = disabled;
    $("#refresh-button").innerHTML =
      `${icon("refresh", state.busy ? "spinning" : "")}<span>${state.cancelled ? "Scan again" : "Refresh"}</span>`;
    $("#cleanup-button").disabled =
      disabled || !state.revision || !ready.length;
    $("#cleanup-button").innerHTML =
      `${icon(workspace.removing ? "refresh" : "cleanup", workspace.removing ? "spinning" : "")}<span>${workspace.removing ? "Deleting…" : `Delete merged${ready.length ? ` (${ready.length})` : ""}`}</span>`;
    $("#cleanup-button").title =
      `Remove ${ready.length} recommended worktrees on ${machineName()} and reclaim ${size(sizeOf(ready))}. Branches are kept.`;
  }
  function renderProgress() {
    const state = workspace.snapshot;
    const hostList = $("#host-progress-list");
    const progress = hostProgress(state.hosts);
    $("#scan-progress").hidden = !progress.visible;
    document.body.classList.toggle("scan-active", progress.visible);
    hostList.hidden = false;
    hostList.innerHTML = progress.markup;
    $("#progress-stage").textContent = progress.active
      ? `Scanning ${progress.active} ${progress.active === 1 ? "machine" : "machines"} in the background`
      : "Scan activity";
    $("#stop-scan").hidden = !progress.canCancel;
    $("#stop-scan").disabled = !progress.canCancel;
    $("#stop-scan").textContent = "Stop all scans";
  }
  function render() {
    const state = workspace.snapshot,
      list = items(),
      repos = new Set(list.map(repoID)),
      activeHosts = state.hosts.filter((source) => source.busy).length;
    $("#window-context").textContent =
      state.hostFilter === null
        ? "All machines — Arbor"
        : state.host
          ? `${state.host} — Arbor`
          : "Arbor";
    $("#connection-label").textContent =
      state.hostFilter === null
        ? "All workspaces"
        : state.host
          ? "SSH workspace"
          : "Local workspace";
    $("#version").textContent = state.version || "";
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
        : `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} · ${activeHosts ? `${activeHosts} scanning in background` : `${repos.size} ${repos.size === 1 ? "repository" : "repositories"}`}`;
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

    const error = workspace.error,
      message = error || workspace.warning || "",
      kind = error ? "error" : "warning";
    $("#error-banner").hidden = !message;
    $("#error-banner").dataset.kind = kind;
    $("#error-banner").setAttribute("role", error ? "alert" : "status");
    $("#error-message").textContent = message;
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
  $("#cleanup-button").onclick = () =>
    workspace.remove(
      items().filter((w) => w.recommended),
      true,
    );
  $("#dismiss-error").onclick = workspace.dismissError;
  return { render };
}
