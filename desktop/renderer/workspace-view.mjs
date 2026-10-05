import {
  icon,
  size,
  sizeOf,
  ago,
  fullDate,
  repoID,
  sentenceCase,
} from "./presentation.mjs";
import { hostProgress } from "./host-progress.mjs";

// How long Delete recommended stays armed, waiting for its confirming click.
const CONFIRM_WINDOW = 5000;
// A confirmation is a second decision. The second half of a double-click
// arrives sooner than anyone could have read what the button now says.
const CONFIRM_DELAY = 400;

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
  // Consent is for these worktrees at these commits in this scope, so a
  // rescan that moves one of them is a different question.
  const selectionKey = (rows) =>
    JSON.stringify([
      workspace.snapshot.hostFilter,
      rows.map((row) => [row.id, row.head]),
    ]);
  // Read by screen readers when it changes; never drawn.
  let announced = "";
  function announce(message) {
    if (message === announced) return;
    announced = message;
    $("#announcement").textContent = message;
  }
  // `outcome` is said aloud, so the question is heard to end as well as to
  // begin, and asking it again is heard as a new question.
  function disarm(outcome = "") {
    if (!armed) return;
    timers.clearTimeout(armed.timer);
    timers.clearTimeout(armed.settle);
    armed = null;
    announce(outcome);
  }
  const plural = (count, noun) => `${count} ${count === 1 ? noun : `${noun}s`}`;
  function renderControls() {
    const state = workspace.snapshot;
    const disabled = blocked(),
      ready = recommended(),
      count = plural(ready.length, "worktree"),
      button = $("#cleanup-button");
    $("#refresh-button").disabled = disabled;
    $("#refresh-button").innerHTML =
      `${icon("refresh", state.busy ? "spinning" : "")}<span>${state.cancelled ? "Scan again" : "Refresh"}</span>`;
    // Consent is for the rows it was given for, and only while they can go.
    if (armed && (disabled || armed.key !== selectionKey(ready)))
      disarm("The worktrees changed. Nothing was deleted.");
    button.disabled = disabled || !state.revision || !ready.length;
    button.classList.toggle("armed", !!armed);
    // A running operation is not an unavailable one; it stays fully legible.
    button.setAttribute("aria-busy", String(workspace.removing));
    // Every label is laid out and one is shown, so the button keeps the width
    // of its longest and nothing beside it moves while a deletion is confirmed.
    const labels = {
      idle: `Delete recommended${ready.length ? ` (${ready.length})` : ""}`,
      armed: `Confirm: delete ${count}`,
      busy: "Deleting…",
    };
    const current = workspace.removing ? "busy" : armed ? "armed" : "idle";
    // Each carries its own icon, so icon and words stay centred together.
    button.innerHTML = `<span class="cleanup-labels">${Object.entries(labels)
      .map(
        ([name, label]) =>
          `<span class="cleanup-label" data-current="${name === current}">${name === "busy" ? icon("refresh", name === current ? "spinning" : "") : icon("trash")}<span>${label}</span></span>`,
      )
      .join("")}</span>`;
    const scope = shown().filtering ? "shown in this view" : `on ${hostName()}`;
    const consequence = `${count} ${scope}, about ${size(sizeOf(ready))}`;
    button.title = armed
      ? `Click again to delete ${consequence}. Branches and commits are kept.`
      : `Delete the ${count} recommended ${scope}, about ${size(sizeOf(ready))}: the rows marked Merged. Branches and commits are kept. Asks once before deleting.`;
    renderStatus();
    if (armed)
      announce(
        `Ready to delete ${consequence}. Activate the button again to confirm, or press Escape.`,
      );
  }
  // The status bar counts what is listed. While a deletion waits to be
  // confirmed, it says what confirming will do.
  function renderStatus() {
    const state = workspace.snapshot,
      list = items(),
      repos = new Set(list.map(repoID)),
      activeHosts = state.hosts.filter((source) => source.busy).length;
    // Totals from the hosts that answered are not totals for all of them.
    const unavailable = state.hosts.filter(
      (source) => source.error && !source.busy,
    ).length;
    const ready = recommended();
    const detail = activeHosts
      ? `${activeHosts === 1 ? "scan" : `${activeHosts} scans`} in progress`
      : shown().selectedCount === 1
        ? // The bulk controls appear with a second row; say how to get one.
          `1 selected · Shift- or ${state.platform === "darwin" ? "⌘" : "Ctrl"}-click to add more`
        : `${repos.size} ${repos.size === 1 ? "repository" : "repositories"}`;
    $("#status-message").textContent = state.setupRequired
      ? "Choose a folder to scan to get started"
      : workspace.removing
        ? "Deleting worktrees…"
        : armed
          ? `Click again to delete ${plural(ready.length, "worktree")}, about ${size(sizeOf(ready))}. Branches and commits are kept.`
          : `${plural(list.length, "worktree")} · ${detail}${state.hostFilter === null && unavailable ? ` · ${plural(unavailable, "host")} unavailable` : ""}`;
    // What confirming will do matters more than when the list was scanned.
    $("#space-label").hidden = $("#scan-time").hidden = !!armed;
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
    $("#error-message").textContent = sentenceCase(message);
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
  $("#cleanup-button").onclick = (event) => {
    const ready = recommended();
    if (!ready.length) return;
    if (armed?.key === selectionKey(ready)) {
      // The rest of a double-click is the same gesture, not a second one.
      if (!armed.ready || event?.detail > 1) return;
      disarm();
      renderControls();
      return workspace.remove(ready, true);
    }
    disarm();
    const asked = (armed = {
      key: selectionKey(ready),
      ready: false,
      settle: timers.setTimeout(() => {
        asked.ready = true;
      }, CONFIRM_DELAY),
      timer: timers.setTimeout(() => {
        if (armed !== asked) return;
        disarm("Not confirmed in time. Nothing was deleted.");
        renderControls();
      }, CONFIRM_WINDOW),
    });
    renderControls();
  };
  $("#cleanup-button").addEventListener("keydown", (event) => {
    // A held Enter repeats the activation; only a fresh press may confirm.
    if (event.repeat && event.key === "Enter") event.preventDefault();
    if (event.key === "Escape" && armed) {
      event.preventDefault();
      disarm("Cancelled. Nothing was deleted.");
      renderControls();
    }
  });
  // Looking away withdraws the question, as closing a dialog would.
  $("#cleanup-button").addEventListener("blur", () => {
    if (!armed) return;
    disarm("Cancelled. Nothing was deleted.");
    renderControls();
  });
  $("#dismiss-error").onclick = workspace.dismissError;
  return { render, renderControls };
}
