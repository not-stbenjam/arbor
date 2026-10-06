"use strict";

const defaults = require("../internal/config/defaults.json");
const DEFAULTS = Object.freeze({
  ...defaults,
  excludes: Object.freeze([...defaults.excludes]),
});
const DEFAULT_EXCLUDES = DEFAULTS.excludes;
// Rules added to the defaults since the first release, by defaults version. A
// saved list that still equals an earlier version's defaults was never
// customized and follows the upgrade. The saved version marks a list its
// owner trimmed back on purpose, which no later upgrade restores.
const DEFAULT_ADDITIONS = [
  ["~/.codex/.tmp"],
  ["~/.local/share/containers", "~/.local/share/docker"],
];
const EXCLUSION_DEFAULTS_VERSION = DEFAULT_ADDITIONS.length;
// One scan report and one cleanup selection share this bound.
const MAX_WORKTREES = 20000;
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
  "fresh",
  "canRemove",
  "canDiscard",
  "recommended",
];
const listFields = [
  "publishedRefs",
  "blockers",
  "problems",
  "discardWarnings",
  "losses",
];
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

const absentOr = (value, valid) => value == null || valid(value);

function isValidReport(report) {
  if (
    !report ||
    !boundedText(report.root) ||
    !Array.isArray(report.warnings) ||
    !report.warnings.every(displayText) ||
    !Array.isArray(report.worktrees) ||
    report.worktrees.length > MAX_WORKTREES ||
    // Scan metadata is rendered too. A cached file is not trusted input.
    !absentOr(report.scannedAt, boundedText) ||
    !absentOr(
      report.durationMs,
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    !absentOr(report.github, (value) => typeof value === "boolean") ||
    !absentOr(report.fetched, (value) => typeof value === "boolean")
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
  if (value.stage.startsWith("files-")) {
    if (
      !["files-git", "files-search", "files-measure"].includes(value.stage) ||
      value.path.includes("\0") ||
      value.completed > value.total ||
      (value.stage !== "files-measure" && (value.total !== 0 || value.completed !== 0))
    )
      return null;
  }
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
  // While a folder is deleted: a file going about now and how many are gone.
  // Each is optional, and one that is malformed is left out, not passed on.
  if (boundedText(value.current)) result.current = value.current;
  // The command-line program leaves a count of none unsaid, so a total with
  // no count beside it means none have gone yet.
  const files = value.files ?? 0;
  if (
    [files, value.filesTotal].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) &&
    files <= value.filesTotal
  ) {
    result.files = files;
    result.filesTotal = value.filesTotal;
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
    sort: ["path", "branch", "repo", "activity", "size"].includes(value.sort)
      ? value.sort
      : "path",
    descending: value.descending === true,
    sidebarWidth: require("./common/sidebar-layout.mjs").sidebarWidth(value.sidebarWidth),
    sidebarHidden: value.sidebarHidden === true,
    hostFilter:
      typeof value.hostFilter === "string" &&
      isValidSSHHost(value.hostFilter, { allowLocal: true })
        ? value.hostFilter
        : null,
    hosts,
    roots: roots.map((root) => text(root, "recent folder")),
    setupCompleted: value.setupCompleted === true,
    exclusionDefaultsVersion: EXCLUSION_DEFAULTS_VERSION,
    scan,
    scans,
  };
}

function loadPreferences(value) {
  const preferences = validatePreferences(value);
  const saved = value.exclusionDefaultsVersion;
  const version =
    Number.isInteger(saved) && saved > 0
      ? Math.min(saved, EXCLUSION_DEFAULTS_VERSION)
      : 0;
  // Upgrade an untouched default list, not custom exclusions or an explicitly
  // empty list. An explicitly trimmed list keeps its newer version marker.
  const later = new Set(DEFAULT_ADDITIONS.slice(version).flat());
  const untouched = DEFAULT_EXCLUDES.filter((rule) => !later.has(rule));
  if (later.size)
    for (const options of [preferences.scan, ...preferences.scans]) {
      const rules = options.excludes;
      if (
        rules.length === untouched.length &&
        new Set(rules).size === untouched.length &&
        untouched.every((rule) => rules.includes(rule))
      )
        options.excludes = [...DEFAULT_EXCLUDES];
    }
  return preferences;
}

// Restore accepts history IDs only: paths and commands never come from the window.
const deletionID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validDeletionID = (value) =>
  typeof value === "string" && value.length === 36 && deletionID.test(value);

function restoreSelection(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 200 ||
    !value.every(validDeletionID) ||
    new Set(value).size !== value.length
  )
    throw new Error("Choose valid recent deletions");
  return [...value];
}

function deletionEntry(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !validDeletionID(value.id) ||
    !isValidSSHHost(value.host, { allowLocal: true }) ||
    !["path", "repo", "commonDir", "branch", "head", "retainedBranch"].every(
      (key) => boundedText(value[key]),
    ) ||
    !value.path.startsWith("/") ||
    !value.commonDir.startsWith("/") ||
    ![40, 64].includes(value.head.length) ||
    !/^[a-fA-F0-9]+$/.test(value.head) ||
    typeof value.detached !== "boolean" ||
    typeof value.clean !== "boolean" ||
    (value.detached ? value.branch !== "" : !value.branch) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    !Number.isSafeInteger(value.deletedAt) ||
    value.deletedAt <= 0
  )
    throw new Error("Invalid recent deletion");
  return Object.fromEntries(
    [
      "id",
      "host",
      "path",
      "repo",
      "commonDir",
      "branch",
      "head",
      "detached",
      "retainedBranch",
      "sizeBytes",
      "deletedAt",
      "clean",
    ].map((key) => [key, value[key]]),
  );
}

module.exports = {
  deletionEntry,
  restoreSelection,
  parseFiles: require("./worktree-files.cjs").parseFiles,
  DEFAULTS,
  DEFAULT_EXCLUDES,
  MAX_WORKTREES,
  scanOptions,
  validatePreferences,
  loadPreferences,
  parseReport,
  progressEvent,
  isValidReport,
  normalizeReport,
};
