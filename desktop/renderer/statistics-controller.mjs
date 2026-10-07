import { icon, esc, size, fullDate } from "./presentation.mjs";

const statisticCount = (value) =>
  Number.isFinite(value) && value >= 0 ? value : 0;
// Daily totals are stored by UTC date, so their labels are read the same way.
const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
// The top of a chart's scale: a round value at or above the largest day
// whose half is round too, so the line across the middle can be labelled. A
// size is rounded in the unit it is shown in, 16 GB rather than
// 17,179,869,184, and its half is never less than one of that unit.
export function scaleTop(maximum, whole) {
  // A damaged record is not a reason to draw to the sky, or for ever.
  maximum = Number.isFinite(maximum) ? clampScale(maximum) : 1;
  let unit = 1;
  if (!whole) while (maximum >= unit * 1024 && unit < 1024 ** 4) unit *= 1024;
  const half = maximum / unit / 2;
  const steps = whole ? [1, 2, 3, 4, 5, 6, 8] : [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
  for (let power = 1; ; power *= 10) {
    const step = steps.find((value) => value * power >= half);
    if (step) return 2 * step * power * unit;
  }
}
const clampScale = (value) => Math.min(Math.max(value, 1), 1e15);
// What one day's bar stands for, in words.
const counted = (value) =>
  value
    ? `${value.toLocaleString()} ${value === 1 ? "worktree" : "worktrees"} deleted`
    : "Nothing deleted";
const recovered = (value) => (value ? `${size(value)} recovered` : "Nothing recovered");
const CHARTS = {
  removedWorktrees: {
    label: "Worktrees deleted",
    whole: true,
    format: (n) => n.toLocaleString(),
    say: counted,
  },
  estimatedBytesReclaimed: {
    label: "Space recovered",
    whole: false,
    format: size,
    say: recovered,
  },
};
const dayName = (days, index) =>
  index === days.length - 1 ? "Today" : dayLabel.format(new Date(days[index].date));
function statisticsChart(days, field) {
  const { label, whole, format } = CHARTS[field];
  const maximum = Math.max(1, ...days.map((day) => statisticCount(day[field])));
  const top = scaleTop(maximum, whole);
  // A day with nothing recorded draws nothing; a stub would read as a value.
  const bars = days
    .map((day, i) => {
      const value = statisticCount(day[field]);
      if (!value) return "";
      const height = Math.max(2, (value / top) * 74);
      return `<rect class="statistics-bar" x="${i * 10 + 2}" y="${80 - height}" width="6" height="${height}" rx="2"/>`;
    })
    .join("");
  const total = days.reduce((sum, day) => sum + statisticCount(day[field]), 0);
  // The plot is one stop for the keyboard: a choice of day, which starts at
  // today. Arrow keys walk the days, each read out beneath the chart and to
  // a screen reader. Pointing at a day shows it too, without choosing it.
  const today = days.length - 1;
  return `<section class="statistics-chart-card"><div class="statistics-chart-heading"><h4>${esc(label)}</h4><strong>${esc(format(total))}</strong></div><div class="statistics-plot" data-chart="${field}" data-day="${today}" tabindex="0" role="slider" aria-orientation="horizontal" aria-label="Day in the ${esc(label.toLowerCase())} chart: ${esc(format(total))} in the last 30 days" aria-valuemin="1" aria-valuemax="${days.length}" aria-valuenow="${days.length}" aria-valuetext="${esc(`${dayName(days, today)}: ${CHARTS[field].say(statisticCount(days[today][field]))}`)}"><svg class="statistics-chart" data-testid="statistics-chart" viewBox="0 0 300 86" aria-hidden="true"><rect class="statistics-day" y="0" width="10" height="86" visibility="hidden"/><path class="statistics-grid" d="M0 6h300M0 43h300M0 80h300"/>${bars}</svg><div class="statistics-scale" aria-hidden="true"><span>${esc(format(top))}</span><span>${esc(format(top / 2))}</span><span>0</span></div></div><div class="statistics-axis"><span>${esc(dayLabel.format(new Date(days[0].date)))}</span><span class="statistics-readout"></span><span>Today</span></div></section>`;
}

// Each opening owns its request; closed dialogs and switched hosts cannot be overwritten.
export function createStatisticsController({
  document,
  api,
  getHost,
  hostName = (host) => host || "This computer",
}) {
  const $ = (selector) => document.querySelector(selector);
  let statisticsGeneration = 0;
  // The thirty days the charts are drawing, for reading one of them out.
  let charted = [];
  // Shows one day of a chart beneath it, or none.
  function show(plot, index) {
    const { format } = CHARTS[plot.dataset.chart];
    const marker = plot.querySelector(".statistics-day"),
      readout = plot.parentElement.querySelector(".statistics-readout");
    if (index === null || !charted[index]) {
      marker.setAttribute("visibility", "hidden");
      readout.textContent = "";
      return;
    }
    marker.setAttribute("x", index * 10);
    marker.setAttribute("visibility", "visible");
    // Under its chart the figure needs no more words than the chart's own
    // heading gives it.
    readout.textContent = `${dayName(charted, index)}: ${format(statisticCount(charted[index][plot.dataset.chart]))}`;
  }
  // The day the keyboard has chosen. It is what a screen reader is told, as
  // a sentence, and what shows while the plot has the keyboard.
  const chosen = (plot) => clamp(Number(plot.dataset.day), charted.length - 1);
  function choose(plot, index) {
    const { say } = CHARTS[plot.dataset.chart];
    plot.dataset.day = index;
    plot.setAttribute("aria-valuenow", index + 1);
    plot.setAttribute("aria-valuetext", `${dayName(charted, index)}: ${say(statisticCount(charted[index][plot.dataset.chart]))}`);
    show(plot, index);
  }
  const clamp = (index, last) => (Number.isInteger(index) ? Math.min(Math.max(index, 0), last) : last);
  const plotOf = (event) => event.target.closest?.(".statistics-plot");
  const focused = (plot) => plot.matches?.(":focus") ?? false;
  $("#statistics-content").addEventListener("keydown", (event) => {
    const plot = plotOf(event);
    if (!plot || !charted.length) return;
    const last = charted.length - 1,
      at = chosen(plot);
    const next = {
      ArrowLeft: Math.max(0, at - 1),
      ArrowRight: Math.min(last, at + 1),
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(plot, next);
  });
  $("#statistics-content").addEventListener("focusin", (event) => {
    const plot = plotOf(event);
    if (plot && charted.length) show(plot, chosen(plot));
  });
  $("#statistics-content").addEventListener("focusout", (event) => {
    const plot = plotOf(event);
    if (plot) show(plot, null);
  });
  $("#statistics-content").addEventListener("pointermove", (event) => {
    const plot = plotOf(event);
    if (!plot || !charted.length) return;
    const box = plot.querySelector("svg").getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * charted.length);
    // Over the margin beside the drawing there is no day to point at.
    show(plot, index >= 0 && index < charted.length ? index : focused(plot) ? chosen(plot) : null);
  });
  $("#statistics-content").addEventListener("pointerout", (event) => {
    const plot = plotOf(event);
    // The pointer has left the plot, not moved between two of its parts.
    // What the keyboard had chosen, if it is still there, shows again.
    if (plot && !plot.contains(event.relatedTarget))
      show(plot, focused(plot) ? chosen(plot) : null);
  });
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
      charted = days;
      const card = (value, label) =>
        `<div class="statistics-metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
      const scope = `<div class="statistics-scope">${icon(host !== "" ? "server" : "monitor")}<span>${esc(host === null ? "All hosts" : hostName(host))}</span></div>`;
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
        <div class="statistics-charts">${statisticsChart(days, "removedWorktrees")}${statisticsChart(days, "estimatedBytesReclaimed")}</div>
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
