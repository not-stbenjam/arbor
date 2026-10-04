import { icon, esc, size, fullDate } from "./presentation.mjs";

const statisticCount = (value) =>
  Number.isFinite(value) && value >= 0 ? value : 0;
function statisticsChart(days, field, label, format) {
  const maximum = Math.max(1, ...days.map((day) => statisticCount(day[field])));
  const bars = days
    .map((day, i) => {
      const value = statisticCount(day[field]),
        height = (value / maximum) * 74;
      return `<rect class="statistics-bar${value ? "" : " empty"}" x="${i * 10 + 2}" y="${80 - Math.max(2, height)}" width="6" height="${Math.max(2, height)}" rx="2"><title>${esc(day.date)}: ${esc(format(value))}</title></rect>`;
    })
    .join("");
  const total = days.reduce((sum, day) => sum + statisticCount(day[field]), 0);
  return `<section class="statistics-chart-card"><div class="statistics-chart-heading"><h3>${esc(label)}</h3><strong>${esc(format(total))}</strong></div><svg class="statistics-chart" data-testid="statistics-chart" viewBox="0 0 300 86" role="img" aria-label="${esc(label)} in the last 30 days: ${esc(format(total))}"><path class="statistics-grid" d="M0 6h300M0 43h300M0 80h300"/>${bars}</svg><div class="statistics-axis"><span>30 days ago</span><span>Today</span></div></section>`;
}

// Each opening owns its request; closed dialogs and switched hosts cannot be overwritten.
export function createStatisticsController({ document, api, getHost }) {
  const $ = (selector) => document.querySelector(selector);
  let statisticsGeneration = 0;
  async function openStatistics() {
    const generation = ++statisticsGeneration,
      requestedHost = getHost();
    const content = $("#statistics-content"),
      dialog = $("#statistics-dialog");
    content.innerHTML = '<p class="statistics-loading">Loading statistics…</p>';
    if (!dialog.open) dialog.showModal();
    try {
      const { host, report } = await api.getStats(requestedHost);
      if (
        generation !== statisticsGeneration ||
        !dialog.open ||
        host !== requestedHost ||
        requestedHost !== getHost()
      )
        return;
      const removed = statisticCount(report.removedWorktrees),
        bytes = statisticCount(report.estimatedBytesReclaimed);
      const missing = statisticCount(report.missingRegistrations);
      const dayMap = new Map(report.daily.map((day) => [day.date, day]));
      const today = new Date();
      const days = Array.from({ length: 30 }, (_, i) => {
        const date = new Date(
          Date.UTC(
            today.getUTCFullYear(),
            today.getUTCMonth(),
            today.getUTCDate() - 29 + i,
          ),
        )
          .toISOString()
          .slice(0, 10);
        return dayMap.get(date) || { date };
      });
      const card = (value, label) =>
        `<div class="statistics-metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
      content.innerHTML = `<div class="statistics-scope">${icon(host !== "" ? "server" : "monitor")}<span>${esc(host === null ? "All hosts" : host || "This computer")}</span><span class="statistics-lifetime">All time</span></div>
        <div class="statistics-hero"><div><span class="statistics-eyebrow">A little more breathing room</span><strong data-stat="estimatedBytesReclaimed">${esc(size(bytes))}</strong><span>estimated space recovered</span></div><div class="statistics-removed"><strong data-stat="removedWorktrees">${removed.toLocaleString()}</strong><span>worktrees cleaned up</span></div></div>
        <div class="statistics-metrics">${card(statisticCount(report.cleanupSessions).toLocaleString(), "Cleanup sessions")}${card(size(report.largestWorktreeBytes), "Largest checkout")}${card(size(removed > missing ? bytes / (removed - missing) : 0), "Average checkout")}</div>
        <div class="statistics-charts">${statisticsChart(days, "removedWorktrees", "Worktrees cleaned up", (n) => n.toLocaleString())}${statisticsChart(days, "estimatedBytesReclaimed", "Space recovered", size)}</div>
        ${!removed ? '<p class="statistics-empty">Your next cleanup starts the story. Successful deletions from the app and CLI will appear here.</p>' : `<div class="statistics-detail"><span>Last cleanup</span><strong>${esc(fullDate(report.lastCleanupAt))}</strong></div><div class="statistics-detail"><span>Missing registrations cleaned up</span><strong>${missing.toLocaleString()}</strong></div><div class="statistics-detail"><span>Detached commits retained</span><strong>${statisticCount(report.detachedCommitsRetained).toLocaleString()}</strong></div>`}
        <p class="statistics-note">Space is estimated from checkout sizes at deletion, not a measurement of free disk space. Missing checkouts count as zero bytes. Charts use UTC dates.</p>
        ${report.warning ? `<p class="statistics-warning">${esc(report.warning)}</p>` : ""}`;
      $("#statistics-dialog .statistics-footer").textContent =
        `Desktop + CLI · Stored ${host === null ? "on each host" : host ? "on this SSH host" : "on this computer"} · No worktree path history`;
    } catch (error) {
      if (
        generation !== statisticsGeneration ||
        !dialog.open ||
        requestedHost !== getHost()
      )
        return;
      content.innerHTML = `<p class="statistics-warning">${esc(error.message || "Statistics could not be loaded.")}</p>`;
    }
  }
  $("#statistics-dialog").addEventListener("close", () => {
    // Native close events are queued: an earlier close can arrive after the
    // dialog has reopened. Opening already invalidates the previous request.
    if (!$("#statistics-dialog").open) statisticsGeneration++;
  });
  return {
    open: openStatistics,
    invalidate() {
      statisticsGeneration++;
    },
  };
}
