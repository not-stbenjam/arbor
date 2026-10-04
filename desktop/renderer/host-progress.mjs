import { esc, icon, describeProgress } from "./presentation.mjs";

// Display-only projection of independently running machine scans.
export function hostProgress(hosts) {
  const active = hosts.filter((source) => source.busy);
  return {
    active: active.length,
    visible: hosts.some(
      (source) => source.busy || source.cancelled || source.error,
    ),
    canCancel: hosts.some(
      (source) => source.canCancelScan && !source.cancelRequested,
    ),
    markup: hosts
      .map((source) => {
        const name = source.label || source.host || "This computer";
        const { stage, countText } = describeProgress(
          source,
          source.operation === "remove",
        );
        const status = source.error
          ? source.error
          : source.busy
            ? stage
            : source.cancelled
              ? "Scan stopped"
              : source.report
                ? "Saved results ready"
                : "Not scanned yet";
        const detail = source.busy
          ? [source.progress?.path || source.root, countText]
              .filter(Boolean)
              .join(" · ")
          : source.root || "";
        const stop = source.canCancelScan || source.cancelRequested;
        return `<div class="host-progress-row" data-progress-host="${esc(source.host)}"><div class="host-progress-heading">${icon(source.busy ? "refresh" : source.host ? "server" : "monitor", source.busy ? "spinning" : "")}<strong>${esc(name)}</strong><span title="${esc(status)}">${esc(status)}</span>${stop ? `<button class="button" data-stop-host="${esc(source.host)}" ${source.cancelRequested ? "disabled" : ""} aria-label="Stop scan on ${esc(name)}">${source.cancelRequested ? "Stopping…" : "Stop"}</button>` : ""}</div>${detail ? `<div class="host-progress-detail" title="${esc(detail)}">${esc(detail)}</div>` : ""}</div>`;
      })
      .join(""),
  };
}
