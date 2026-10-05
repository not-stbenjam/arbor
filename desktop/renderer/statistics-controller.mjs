import { icon, esc, size, fullDate } from "./presentation.mjs";

const statisticCount = (value) =>
  Number.isFinite(value) && value >= 0 ? value : 0;
// Daily totals are stored by UTC date, so their labels are read the same way.
const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
function statisticsChart(days, field, label, format) {
  const maximum = Math.max(1, ...days.map((day) => statisticCount(day[field])));
  // A day with nothing recorded draws nothing; a stub would read as a value.
  const bars = days
    .map((day, i) => {
      const value = statisticCount(day[field]);
      if (!value) return "";
      const height = Math.max(2, (value / maximum) * 74);
      return `<rect class="statistics-bar" x="${i * 10 + 2}" y="${80 - height}" width="6" height="${height}" rx="2"><title>${esc(dayLabel.format(new Date(day.date)))}: ${esc(format(value))}</title></rect>`;
    })
    .join("");
  const total = days.reduce((sum, day) => sum + statisticCount(day[field]), 0);
  return `<section class="statistics-chart-card"><div class="statistics-chart-heading"><h4>${esc(label)}</h4><strong>${esc(format(total))}</strong></div><svg class="statistics-chart" data-testid="statistics-chart" viewBox="0 0 300 86" role="img" aria-label="${esc(label)} in the last 30 days: ${esc(format(total))}"><path class="statistics-grid" d="M0 6h300M0 43h300M0 80h300"/>${bars}</svg><div class="statistics-axis"><span>${esc(dayLabel.format(new Date(days[0].date)))}</span><span>Today</span></div></section>`;
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
      const scope = `<div class="statistics-scope">${icon(host !== "" ? "server" : "monitor")}<span>${esc(host === null ? "All hosts" : host || "This computer")}</span></div>`;
      // Totals that leave a host out, or follow a file that could not be
      // read, say so before the numbers rather than after them.
      const warning = report.warning
        ? `<p class="statistics-warning">${icon("warning")}<span>${esc(report.warning)}</span></p>`
        : "";
      content.innerHTML = !removed
        ? // A host that could not answer may have a history; say only what is known.
          `${scope}${warning}<div class="statistics-none">${icon("chart")}<h3>${report.warning ? "No cleanups recorded on the hosts that answered" : "No cleanups yet"}</h3><p>Worktrees you delete here or with the <code>arbor</code> command are counted from now on, along with the space they held.</p></div>`
        : `${scope}${warning}
        <div class="statistics-hero"><div><span class="statistics-eyebrow">All time</span><strong data-stat="estimatedBytesReclaimed">${esc(size(bytes))}</strong><span>estimated space recovered</span></div><div class="statistics-removed"><strong data-stat="removedWorktrees">${removed.toLocaleString()}</strong><span>worktrees deleted</span></div></div>
        <div class="statistics-metrics">${card(statisticCount(report.cleanupSessions).toLocaleString(), "Cleanups")}${card(size(report.largestWorktreeBytes), "Largest worktree")}${card(size(removed > missing ? bytes / (removed - missing) : 0), "Average worktree")}</div>
        <h3 class="statistics-period">Last 30 days</h3>
        <div class="statistics-charts">${statisticsChart(days, "removedWorktrees", "Worktrees deleted", (n) => n.toLocaleString())}${statisticsChart(days, "estimatedBytesReclaimed", "Space recovered", size)}</div>
        <div class="statistics-detail"><span>Last cleanup</span><strong>${esc(fullDate(report.lastCleanupAt))}</strong></div><div class="statistics-detail"><span>Missing worktree registrations removed</span><strong>${missing.toLocaleString()}</strong></div><div class="statistics-detail"><span>Detached commits kept</span><strong>${statisticCount(report.detachedCommitsRetained).toLocaleString()}</strong></div>
        <p class="statistics-note">Space is estimated from each worktree's size when it was deleted, not measured as free disk space. Days are counted in UTC.</p>`;
      $("#statistics-dialog .statistics-footer").textContent =
        `Includes deletions from the app and the command line · Stored ${host === null ? "on each host" : host ? "on this SSH host" : "on this computer"} · No paths are kept`;
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
