"use strict";

const totals = [
  "removedWorktrees",
  "estimatedBytesReclaimed",
  "missingRegistrations",
  "cleanupSessions",
  "detachedCommitsRetained",
];
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
const sum = (left, right) =>
  Math.min(Number.MAX_SAFE_INTEGER, count(left) + count(right));

// Hosts own their persistent history. This is only a read-time combined view.
function aggregateStats(results) {
  const successful = results.filter((entry) => entry.report);
  if (results.length && !successful.length)
    throw new Error("Statistics could not be loaded from any host.");
  const report = { version: 1, daily: [], largestWorktreeBytes: 0 };
  for (const key of totals) report[key] = 0;
  const days = new Map(),
    warnings = [];
  for (const { host, report: source, error } of results) {
    const label = host || "This computer";
    if (!source) {
      warnings.push(
        `${label}: ${String(error?.message || error || "Statistics unavailable").slice(0, 1024)}`,
      );
      continue;
    }
    for (const key of totals) report[key] = sum(report[key], source[key]);
    report.largestWorktreeBytes = Math.max(
      report.largestWorktreeBytes,
      count(source.largestWorktreeBytes),
    );
    for (const key of ["firstCleanupAt", "lastCleanupAt"]) {
      const value = source[key];
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
        continue;
      if (
        !report[key] ||
        (key === "firstCleanupAt"
          ? Date.parse(value) < Date.parse(report[key])
          : Date.parse(value) > Date.parse(report[key]))
      )
        report[key] = value;
    }
    for (const day of source.daily || []) {
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
      const merged = days.get(day.date) || { date: day.date };
      for (const key of totals) merged[key] = sum(merged[key], day[key]);
      days.set(day.date, merged);
    }
    if (source.warning)
      warnings.push(`${label}: ${String(source.warning).slice(0, 1024)}`);
  }
  report.daily = [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);
  if (warnings.length)
    report.warning = `Partial totals. ${warnings.join("; ")}`;
  return report;
}

module.exports = { aggregateStats };
