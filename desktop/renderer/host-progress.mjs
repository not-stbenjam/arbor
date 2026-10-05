import { esc, icon, describeProgress } from "./presentation.mjs";

// Display-only projection of scan activity. A host appears while it is
// scanning, queued or stopping, and after its scan was stopped, since its
// list may then be incomplete. A finished host has nothing left to report,
// and a failure belongs to the error banner, said once.
export function hostProgress(hosts) {
  const stoppable = (source) => source.canCancelScan && !source.cancelRequested;
  const rows = hosts.filter(
    (source) => source.busy || source.cancelRequested || source.cancelled,
  );
  return {
    active: hosts.filter((source) => source.busy).length,
    visible: rows.length > 0,
    // One host has its own Stop; a shared one only helps with several.
    canCancelAll: hosts.filter(stoppable).length > 1,
    // What each host is doing, without the paths and counts that change
    // constantly: the part worth saying aloud once.
    summary: rows
      .map(
        (source) =>
          `${source.label || source.host || "This computer"}: ${
            source.busy || source.cancelRequested
              ? describeProgress(source, source.operation === "remove").stage
              : "Scan stopped"
          }`,
      )
      .join(". "),
    markup: rows
      .map((source) => {
        const name = source.label || source.host || "This computer";
        const { stage, countText, fraction, current } = describeProgress(
          source,
          source.operation === "remove",
        );
        const status =
          source.busy || source.cancelRequested ? stage : "Scan stopped";
        const stop = source.canCancelScan || source.cancelRequested;
        const path = source.progress?.path || source.root || "";
        // A bar whenever there is a known end to measure against: worktrees
        // checked, or files of the worktrees being deleted.
        const bar =
          source.busy && typeof fraction === "number"
            ? `<progress class="host-progress-bar" max="1000" value="${Math.round(fraction * 1000)}" aria-label="${esc(status)}"></progress>`
            : "";
        // The count is the part worth reading, so the path gives way first,
        // and the file being deleted before the worktree it is in.
        const detail = source.busy
          ? `<span class="host-progress-path" title="${esc(path)}">${esc(path)}</span>${current ? `<span class="host-progress-file" title="${esc(current)}">${esc(current)}</span>` : ""}${countText ? `<span class="host-progress-count">${esc(countText)}</span>` : ""}`
          : `<span class="host-progress-path">${source.report ? "Showing the results of the last completed scan." : "The list is incomplete."} Refresh to scan again.</span>`;
        return `<div class="host-progress-row" data-progress-host="${esc(source.host)}"><div class="host-progress-heading">${icon(source.busy ? "refresh" : source.host ? "server" : "monitor", source.busy ? "spinning" : "")}<strong>${esc(name)}</strong><span title="${esc(status)}">${esc(status)}</span>${stop ? `<button class="button" data-stop-host="${esc(source.host)}" ${source.cancelRequested ? "disabled" : ""} aria-label="Stop scan on ${esc(name)}">${source.cancelRequested ? "Stopping…" : "Stop"}</button>` : ""}</div>${bar}<div class="host-progress-detail">${detail}</div></div>`;
      })
      .join(""),
  };
}
