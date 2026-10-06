import { ago, viewHost } from "./presentation.mjs";

export const STALE_AFTER = 3600 * 1000;
export function oldestScan(state) {
  const selected = viewHost(state);
  const hosts = (state.hosts || []).filter((h) => selected === null || h.host === selected);
  return hosts
    .filter((h) => Number.isFinite(Date.parse(h.report?.scannedAt)))
    .sort((a, b) => Date.parse(a.report.scannedAt) - Date.parse(b.report.scannedAt))[0];
}

// Time passing does not change the workspace snapshot. Keep this small view
// on its own clock, and check again after the window has been asleep.
export function createStaleNotice({ document, workspace, clock = document.defaultView }) {
  const $ = (s) => document.querySelector(s);
  const dismissed = new Set();
  let shown = "", timer;
  function render() {
    const state = workspace.snapshot;
    const oldest = oldestScan(state);
    const stamp = oldest?.report.scannedAt;
    const key = JSON.stringify([oldest?.host, stamp]);
    const stale = !!oldest && !state.busy && !state.setupRequired &&
      Date.now() - Date.parse(stamp) >= STALE_AFTER && !dismissed.has(key);
    const note = $("#stale-note");
    const held = note.contains?.(document.activeElement);
    note.hidden = !stale;
    shown = stale ? key : "";
    if (stale) {
      const name = viewHost(state) === null ? `${oldest.label || oldest.host || "This computer"}: ` : "";
      $("#stale-text").textContent = `${name}Scanned ${ago(stamp).toLowerCase()}.`;
    } else if (held) $("#worktree-grid").focus({ preventScroll: true });
    if (clock) {
      clock.clearTimeout(timer);
      const remaining = Date.parse(stamp) + STALE_AFTER - Date.now();
      timer = clock.setTimeout(render, remaining > 0 ? Math.min(remaining, 60000) : 60000);
    }
  }
  $("#stale-refresh").onclick = workspace.refresh;
  $("#stale-dismiss").onclick = () => { if (shown) dismissed.add(shown); render(); };
  clock?.addEventListener("focus", render);
  document.addEventListener?.("visibilitychange", render);
  return { render, dispose() {
    clock?.clearTimeout(timer);
    clock?.removeEventListener("focus", render);
    document.removeEventListener?.("visibilitychange", render);
  } };
}
