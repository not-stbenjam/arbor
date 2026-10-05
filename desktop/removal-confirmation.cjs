"use strict";

const path = require("node:path");
const { usesDiscardLocal } = require("./removal-policy.cjs");
const { LOSSES, lossesOf, graveLosses } = require("./common/losses.mjs");

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
  const discarding = existing.filter(
    (row) => !row.empty && usesDiscardLocal(row, discardLocal),
  );
  const discardsFiles = discarding.length > 0;
  // What the last scan found that this deletion would destroy, and in how
  // many of the worktrees. A worktree with any of it is not a clean delete,
  // and the dialog says so before it says anything else.
  const unclean = discarding.filter((row) => lossesOf(row).length);
  const lost = Object.keys(LOSSES)
    .map((name) => [
      name,
      unclean.filter((row) => lossesOf(row).includes(name)).length,
    ])
    .filter(([, count]) => count);
  // The gravest consequence leads; what is kept follows it.
  const notes = [];
  if (unclean.length) {
    notes.push(
      `${
        trees.length === 1
          ? "It holds"
          : unclean.length === trees.length
            ? "They hold"
            : `${unclean.length} of them ${unclean.length === 1 ? "holds" : "hold"}`
      } work that is not saved in Git. Deleting permanently discards:`,
      ...lost.map(
        ([name, count]) =>
          `• ${LOSSES[name].text}${trees.length > 1 ? ` (${count} ${count === 1 ? "worktree" : "worktrees"})` : ""}`,
      ),
      "Anything else in the folder that is not committed goes too, including files added since the last scan.",
    );
  } else if (discardsFiles)
    notes.push(
      "Any local files, including uncommitted, untracked, and ignored files, will be permanently discarded.",
    );
  notes.push(
    registrationsOnly
      ? "Only Git worktree registrations will be removed; their folders are already missing. Git branches and commits are kept."
      : unclean.some((row) => graveLosses(row).length)
        ? // Commits are among what is lost here, so say whose are kept.
          "Worktree folders are deleted permanently, not moved to Trash. The branches and commits of the repository they belong to are kept."
        : "Worktree folders are deleted permanently, not moved to Trash. Git branches and commits are kept.",
  );
  // A folder's Delete can read as deleting the folder. It never does.
  if (existing.length > 1)
    notes.push(
      "Only these worktrees are deleted; a folder that holds them, and anything else in it, is kept.",
    );
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
  // One remote host is easy to overlook when every path looks local.
  if (hosts.size === 1 && [...hosts.keys()][0] !== "")
    notes.unshift(`On ${shorten(hostName([...hosts.values()][0]), 70)}.`);
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
  // What the last scan saw in a row that this operation will discard. It
  // decides which paths the preview shows first, so a selection's risky
  // members are never the ones hidden behind "and more".
  const risk = (row) =>
    row.missing || row.empty || !usesDiscardLocal(row, discardLocal)
      ? ""
      : lossesOf(row)
          .map((name) => LOSSES[name].brief)
          .join(", ") || (row.locked ? "locked" : "");
  // Worktrees that would lose commits or a repository come before those
  // that would lose files, and those before the rest.
  const weight = (row) =>
    !risk(row) ? 0 : unclean.includes(row) && graveLosses(row).length ? 2 : 1;
  if (trees.some((row) => row.locked && usesDiscardLocal(row, discardLocal)))
    notes.push(
      "Git worktree locks on the selected entries will be overridden.",
    );
  if (existing.some((row) => row.detached))
    notes.push(
      "Detached commits will be kept; recovery branches are created only if needed.",
    );
  const preview = trees
    .map((row, index) => ({ row, index, risk: risk(row) }))
    .sort((a, b) => weight(b.row) - weight(a.row) || a.index - b.index)
    .slice(0, 5)
    .map(({ row, risk }) => {
      const suffix = risk ? ` — ${risk}` : "";
      return (
        shorten(
          Object.hasOwn(row, "host")
            ? `${hostName(hosts.get(row.host || ""))}: ${row.path}`
            : row.path,
          120 - suffix.length,
        ) + suffix
      );
    });
  if (trees.length > preview.length)
    preview.push(
      `and ${trees.length - preview.length} more selected ${trees.length - preview.length === 1 ? "worktree" : "worktrees"}`,
    );
  const name = shorten(
    path.basename(trees[0]?.path || "") || trees[0]?.branch || "worktree",
    80,
  );
  const plural = trees.length > 1 ? "s" : "";
  // Some systems show only the message, so it is the message that says this
  // is not an ordinary delete.
  const count = (n) => (n === 2 ? "both" : `all ${n}`);
  return {
    title: registrationsOnly
      ? `Remove missing worktree registration${plural}?`
      : unclean.length
        ? "Not a clean delete"
        : discardsFiles
          ? "Discard local files and delete?"
          : `Delete worktree${plural}?`,
    message: unclean.length
      ? trees.length === 1
        ? `“${name}” is not clean. Discard its work and delete it?`
        : `${unclean.length === trees.length ? count(trees.length).replace(/^./, (c) => c.toUpperCase()) : `${unclean.length} of ${trees.length}`} worktrees${hosts.size > 1 ? ` on ${hosts.size} hosts` : ""} ${unclean.length === 1 ? "is" : "are"} not clean. Discard ${unclean.length === 1 ? "its" : "their"} work and delete ${count(trees.length)}?`
      : trees.length === 1
        ? registrationsOnly
          ? `Remove registration for “${name}”?`
          : `Delete “${name}”${discardsFiles ? " and discard its local files" : ""}?`
        : `${registrationsOnly ? "Remove" : "Delete"} ${trees.length} ${registrationsOnly ? "missing worktree registrations" : "worktrees"}${hosts.size > 1 ? ` on ${hosts.size} hosts` : ""}${discardsFiles ? " and discard their local files" : ""}?`,
    detail: `${notes.join("\n")}\n\n${preview.join("\n")}`,
    buttons: [
      "Cancel",
      registrationsOnly
        ? `Remove Registration${plural}`
        : discardsFiles
          ? "Discard & Delete"
          : `Delete Worktree${plural}`,
    ],
  };
}

module.exports = { removalConfirmationOptions };
