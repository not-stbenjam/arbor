"use strict";

const defaults = require("../internal/config/defaults.json");
const DEFAULTS = Object.freeze({
  ...defaults,
  excludes: Object.freeze([...defaults.excludes]),
});
const DEFAULT_EXCLUDES = DEFAULTS.excludes;
const {
  isValidSSHHost,
  MAX_HOST_LENGTH,
  MAX_HOST_LABEL_LENGTH,
} = require("./common/ssh-host.mjs");

const textFields = [
  "id",
  "path",
  "head",
  "branch",
  "repo",
  "commonDir",
  "subject",
  "author",
  "commitAt",
  "activityAt",
  "lockReason",
  "upstream",
  "defaultRef",
  "mergeReason",
  "githubState",
];
const countFields = ["sizeBytes", "changedFiles", "ahead", "behind"];
const flagFields = [
  "main",
  "bare",
  "detached",
  "locked",
  "missing",
  "empty",
  "outsideRoot",
  "dirty",
  "ignored",
  "published",
  "merged",
  "canRemove",
  "canDiscard",
  "recommended",
];
const listFields = ["publishedRefs", "blockers", "problems", "discardWarnings"];
const displayFields = new Set([
  "subject",
  "author",
  "lockReason",
  "mergeReason",
]);
const displayLists = new Set(["blockers", "problems", "discardWarnings"]);
const displayText = (value) => typeof value === "string";
const boundedText = (value) =>
  typeof value === "string" && value.length <= 4096 && !value.includes("\0");
const clipDisplay = (value) => value.replaceAll("\0", "").slice(0, 4096);

function validWorktree(value, partial = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!["id", "path"].every((key) => boundedText(value[key]) && value[key]))
    return false;
  if (!partial && !["head", "branch"].every((key) => boundedText(value[key])))
    return false;
  if (
    !textFields.every(
      (key) =>
        value[key] === undefined ||
        (displayFields.has(key)
          ? displayText(value[key])
          : boundedText(value[key])),
    )
  )
    return false;
  if (
    !countFields.every(
      (key) =>
        value[key] === undefined ||
        (Number.isSafeInteger(value[key]) && value[key] >= 0),
    )
  )
    return false;
  if (
    !flagFields.every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    )
  )
    return false;
  if (
    !listFields.every(
      (key) =>
        value[key] == null ||
        (Array.isArray(value[key]) &&
          value[key].length <= 10000 &&
          value[key].every(displayLists.has(key) ? displayText : boundedText)),
    )
  )
    return false;
  if (
    value.pr != null &&
    (typeof value.pr !== "object" ||
      Array.isArray(value.pr) ||
      (value.pr.number !== undefined &&
        !Number.isSafeInteger(value.pr.number)) ||
      typeof value.pr.merged !== "boolean" ||
      !["url", "title", "state"].every(
        (key) =>
          value.pr[key] === undefined ||
          (key === "title"
            ? displayText(value.pr[key])
            : boundedText(value.pr[key])),
      ))
  )
    return false;
  return true;
}

function isValidReport(report) {
  if (
    !report ||
    !boundedText(report.root) ||
    !Array.isArray(report.warnings) ||
    !report.warnings.every(displayText) ||
    !Array.isArray(report.worktrees) ||
    report.worktrees.length > 20000
  )
    return false;
  const ids = new Set();
  return report.worktrees.every((row) => {
    if (!validWorktree(row) || ids.has(row.id)) return false;
    ids.add(row.id);
    return true;
  });
}

// Display copy is bounded independently from checkout identity. Long valid Git
// subjects or diagnostic messages must not make a whole workspace disappear.
function normalizeReport(report) {
  if (!isValidReport(report)) return null;
  const result = structuredClone(report);
  result.warnings = result.warnings.map(clipDisplay);
  for (const row of result.worktrees) {
    for (const key of displayFields)
      if (row[key] !== undefined) row[key] = clipDisplay(row[key]);
    for (const key of displayLists)
      if (row[key]) row[key] = row[key].map(clipDisplay);
    if (row.pr?.title !== undefined) row.pr.title = clipDisplay(row.pr.title);
  }
  return result;
}

function partialWorktree(value, pending) {
  if (!validWorktree(value, true)) return null;
  const result = {
    canRemove: false,
    recommended: false,
    canDiscard: false,
    pending: pending !== false,
  };
  for (const key of textFields)
    result[key] = displayFields.has(key)
      ? clipDisplay(value[key] ?? "")
      : (value[key] ?? "");
  for (const key of countFields) result[key] = value[key] ?? 0;
  for (const key of flagFields)
    if (!["canRemove", "canDiscard", "recommended"].includes(key))
      result[key] = value[key] === true;
  for (const key of listFields)
    result[key] = (value[key] ?? [])
      .slice(0, 100)
      .map((item) => (displayLists.has(key) ? clipDisplay(item) : item));
  if (value.pr && Number.isSafeInteger(value.pr.number)) {
    result.pr = { number: value.pr.number, merged: value.pr.merged === true };
    for (const key of ["url", "title", "state"])
      result.pr[key] =
        key === "title"
          ? clipDisplay(value.pr[key] ?? "")
          : (value.pr[key] ?? "");
  }
  return result;
}

function progressEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.stage !== "string" ||
    value.stage.length > 100 ||
    typeof value.path !== "string" ||
    value.path.length > 4096
  )
    return null;
  for (const key of ["discovered", "completed", "total"])
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
  const result = {
    stage: value.stage,
    path: value.path,
    discovered: value.discovered,
    completed: value.completed,
    total: value.total,
  };
  const worktree = partialWorktree(value.worktree, value.pending);
  if (worktree) {
    result.worktree = worktree;
    result.pending = worktree.pending;
  }
  return result;
}

function text(value, name, limit = 4096) {
  if (typeof value !== "string" || value.length > limit || value.includes("\0"))
    throw new Error(`Invalid ${name}`);
  return value;
}

function scanOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid scan options");
  const host = text(value.host ?? "", "SSH host", MAX_HOST_LENGTH);
  if (!isValidSSHHost(host, { allowLocal: true }))
    throw new Error("Use an SSH host alias or user@hostname");
  const excludes =
    value.excludes === undefined ? DEFAULT_EXCLUDES : value.excludes;
  if (!Array.isArray(excludes) || excludes.length > DEFAULTS.maxExcludes)
    throw new Error(`Choose up to ${DEFAULTS.maxExcludes} excluded folders`);
  return {
    root: text(value.root ?? "", "scan folder"),
    host,
    github: value.github === true,
    fetch: value.fetch === true,
    excludes: excludes.map((value) => {
      const entry = text(value, "excluded folder");
      if (!entry.trim()) throw new Error("Excluded folders cannot be empty");
      return entry;
    }),
  };
}

function parseReport(raw) {
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error("Arbor CLI returned invalid JSON");
  }
  if (
    !report ||
    typeof report.root !== "string" ||
    !Array.isArray(report.worktrees) ||
    !Array.isArray(report.warnings)
  )
    throw new Error("Arbor CLI returned an incomplete scan");
  const normalized = normalizeReport(report);
  if (!normalized)
    throw new Error("Arbor CLI returned invalid worktree metadata");
  return normalized;
}

function validatePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid preferences");
  const theme = value.theme ?? "system";
  if (!["system", "light", "dark"].includes(theme))
    throw new Error("Invalid theme");
  if (!Array.isArray(value.hosts ?? []) || (value.hosts?.length ?? 0) > 100)
    throw new Error("Invalid saved hosts");
  const hosts = (value.hosts ?? []).map((item) => {
    if (!item || typeof item !== "object")
      throw new Error("Invalid saved host");
    const host = scanOptions({ host: item.host }).host;
    if (!host) throw new Error("Saved SSH host cannot be empty");
    return {
      name: text(
        item.name || host.slice(0, MAX_HOST_LABEL_LENGTH),
        "host name",
        MAX_HOST_LABEL_LENGTH,
      ),
      host,
      root: text(item.root ?? "~", "remote folder"),
    };
  });
  const roots = value.roots ?? [];
  if (!Array.isArray(roots) || roots.length > 100)
    throw new Error("Invalid recent folders");
  const scan = scanOptions(value.scan || { root: roots[0] || "" });
  const savedScans = value.scans ?? [scan];
  if (!Array.isArray(savedScans) || savedScans.length > 101)
    throw new Error("Invalid per-host scan options");
  const seenHosts = new Set();
  const scans = savedScans.map((value) => {
    const options = scanOptions(value);
    if (seenHosts.has(options.host))
      throw new Error("Duplicate per-host scan options");
    seenHosts.add(options.host);
    return options;
  });
  return {
    theme,
    hosts,
    roots: roots.map((root) => text(root, "recent folder")),
    setupCompleted: value.setupCompleted === true,
    exclusionDefaultsVersion: 1,
    scan,
    scans,
  };
}

function loadPreferences(value) {
  const preferences = validatePreferences(value);
  // Upgrade untouched v0.1.2/v0.1.3 defaults, not custom exclusions or an
  // explicitly empty list. The marker lets users remove the new rule later.
  const previousDefaults = DEFAULT_EXCLUDES.filter(
    (rule) => rule !== "~/.codex/.tmp",
  );
  for (const options of [preferences.scan, ...preferences.scans]) {
    const saved = options.excludes;
    if (
      !value.exclusionDefaultsVersion &&
      saved.length === previousDefaults.length &&
      new Set(saved).size === previousDefaults.length &&
      previousDefaults.every((rule) => saved.includes(rule))
    ) {
      options.excludes = [...DEFAULT_EXCLUDES];
    }
  }
  return preferences;
}

module.exports = {
  DEFAULTS,
  DEFAULT_EXCLUDES,
  scanOptions,
  validatePreferences,
  loadPreferences,
  parseReport,
  progressEvent,
  isValidReport,
  normalizeReport,
};
