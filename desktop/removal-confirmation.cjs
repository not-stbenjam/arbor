"use strict";

const path = require("node:path");
const { usesDiscardLocal } = require("./removal-policy.cjs");

// Native consent copy for an approved removal plan. Pure: it describes what
// the operation will do to the selected rows and never reads application state.
function removalConfirmationOptions(trees, discardLocal) {
  const shorten = (value, limit) => {
    const characters = Array.from(
      String(value || "").replace(
        /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
        " ",
      ),
    );
    if (characters.length <= limit) return characters.join("");
    const start = Math.floor((limit - 1) / 2);
    return (
      characters.slice(0, start).join("") +
      "…" +
      characters.slice(-(limit - start - 1)).join("")
    );
  };
  const existing = trees.filter((row) => !row.missing);
  const missing = trees.length - existing.length;
  const registrationsOnly = missing > 0 && !existing.length;
  // Consent follows the operation, not potentially stale scan metadata.
  const discardsFiles = existing.some(
    (row) => !row.empty && usesDiscardLocal(row, discardLocal),
  );
  const notes = [
    registrationsOnly
      ? "Only Git worktree registrations will be removed; their folders are already missing. Git branches and commits are retained."
      : "The selected worktree folders will be deleted. Git branches and commits are retained.",
  ];
  const hosts = new Map();
  for (const row of trees) {
    const host = row.host || "";
    const entry = hosts.get(host) || {
      host,
      label: row.hostLabel || host || "This computer",
      count: 0,
    };
    entry.count++;
    hosts.set(host, entry);
  }
  const hostName = ({ host, label }) =>
    host && label !== host ? `${label} [${host}]` : label;
  if (hosts.size > 1) {
    const summary = [...hosts.values()]
      .slice(0, 4)
      .map((entry) => `${shorten(hostName(entry), 70)}: ${entry.count}`);
    if (hosts.size > summary.length)
      summary.push(`and ${hosts.size - summary.length} more hosts`);
    notes.push(`Hosts: ${summary.join(" · ")}.`);
  }
  if (missing && !registrationsOnly)
    notes.push(
      `${missing} missing worktree ${missing === 1 ? "registration will" : "registrations will"} also be removed; no folders exist at those paths.`,
    );
  if (discardsFiles)
    notes.push(
      "Any local files, including uncommitted, untracked, and ignored files, will be permanently discarded.",
    );
  if (trees.some((row) => row.locked && usesDiscardLocal(row, discardLocal)))
    notes.push(
      "Git worktree locks on the selected entries will be overridden.",
    );
  if (existing.some((row) => row.detached))
    notes.push(
      "Detached commits will be retained; recovery branches are created only if needed.",
    );
  const preview = trees
    .slice(0, 5)
    .map((row) =>
      shorten(
        Object.hasOwn(row, "host")
          ? `${hostName(hosts.get(row.host || ""))}: ${row.path}`
          : row.path,
        120,
      ),
    );
  if (trees.length > preview.length)
    preview.push(
      `and ${trees.length - preview.length} more selected ${trees.length - preview.length === 1 ? "worktree" : "worktrees"}`,
    );
  const name = shorten(
    path.basename(trees[0]?.path || "") || trees[0]?.branch || "worktree",
    80,
  );
  return {
    title: registrationsOnly
      ? `Remove missing worktree registration${trees.length === 1 ? "" : "s"}?`
      : discardsFiles
        ? "Discard local data and remove?"
        : "Remove worktree?",
    message:
      trees.length === 1
        ? `Remove ${registrationsOnly ? "registration for " : ""}“${name}”?`
        : `Remove ${trees.length} ${registrationsOnly ? "missing worktree registrations" : "worktrees"}${hosts.size > 1 ? ` on ${hosts.size} hosts` : ""}?`,
    detail: `${notes.join("\n")}\n\n${preview.join("\n")}`,
    buttons: [
      "Cancel",
      registrationsOnly
        ? "Remove Registration" + (trees.length > 1 ? "s" : "")
        : discardsFiles
          ? "Discard & Remove"
          : "Remove Worktree" + (trees.length > 1 ? "s" : ""),
    ],
  };
}

module.exports = { removalConfirmationOptions };
