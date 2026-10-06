"use strict";

const { LOSSES } = require("./common/losses.mjs");
const kinds = Object.keys(LOSSES);
const statuses = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
  "conflicted",
];
const text = (value) =>
  typeof value === "string" && value.length <= 4096 && !value.includes("\0");
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const totals = (value) =>
  object(value) &&
  Object.keys(value).length === kinds.length &&
  kinds.every((kind) => count(value[kind])) &&
  count(Object.values(value).reduce((sum, n) => sum + n, 0));

function parseFiles(data) {
  if (typeof data !== "string" || data.length > 16 * 1024 * 1024)
    throw new Error("Arbor returned an oversized file inventory");
  const value = JSON.parse(data);
  const invalid = () => {
    throw new Error("Arbor returned an invalid file inventory");
  };
  if (
    !object(value) ||
    !["path", "head", "branch"].every((key) => text(value[key])) ||
    !value.path ||
    typeof value.truncated !== "boolean" ||
    typeof value.sizeLowerBound !== "boolean" ||
    !totals(value.counts) ||
    !totals(value.bytes) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 70000 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 100 ||
    !value.warnings.every(text)
  )
    invalid();
  const counts = {},
    bytes = {};
  for (const entry of value.entries) {
    if (
      !object(entry) ||
      !kinds.includes(entry.kind) ||
      !text(entry.path) ||
      !entry.path ||
      typeof entry.directory !== "boolean" ||
      typeof entry.sizeLowerBound !== "boolean" ||
      !count(entry.sizeBytes) ||
      (entry.directory && !count(entry.files)) ||
      (entry.files !== undefined && !count(entry.files)) ||
      (entry.kind === "changes"
        ? !statuses.includes(entry.status)
        : entry.status !== undefined)
    )
      invalid();
    // Two entries may read the same: names are written as text, and two
    // files whose names are not text can come out alike.
    counts[entry.kind] = (counts[entry.kind] || 0) + 1;
    bytes[entry.kind] = (bytes[entry.kind] || 0) + entry.sizeBytes;
    if (entry.sizeLowerBound && !value.sizeLowerBound) invalid();
  }
  let cut = false;
  for (const kind of kinds) {
    if (
      (counts[kind] || 0) > value.counts[kind] ||
      (bytes[kind] || 0) > value.bytes[kind]
    )
      invalid();
    if ((counts[kind] || 0) < value.counts[kind]) cut = true;
    else if ((bytes[kind] || 0) !== value.bytes[kind]) invalid();
  }
  if (cut !== value.truncated) invalid();
  return value;
}

module.exports = { parseFiles };
