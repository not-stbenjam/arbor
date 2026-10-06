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
  // A registration whose folder is gone or empty has no files to lose, but
  // what Git kept for its submodules goes with it all the same.
  const forced = trees.filter((row) => usesDiscardLocal(row, discardLocal));
  const unclean = forced.filter((row) => lossesOf(row).length);
  const lost = Object.keys(LOSSES).filter((name) =>
    unclean.some((row) => lossesOf(row).includes(name)));
  const ordinary = lost.filter((name) => !LOSSES[name].grave);
  const grave = lost.filter((name) => LOSSES[name].grave);
  const notes = [];
  if (grave.length) notes.push("Permanently loses:", ...grave.map((name) => `• ${LOSSES[name].text}`));
  if (trees.length > 1 && ordinary.length)
    notes.push(`Discards ${ordinary.map((name) => LOSSES[name].brief).join(" and ")}.`);
  // Forced removal also accepts ordinary files that appeared after inspection.
  if (discardsFiles && !lost.length) notes.push("Any uncommitted files are discarded.");
  if (registrationsOnly) notes.push(trees.length === 1
    ? "Folder already gone; only registration removed."
    : "Folders already gone; registrations only.");
  notes.push(grave.length ? "Parent repository branches are kept." :
    trees.length === 1 ? "Its branch and commits are kept." : "Their branches and commits are kept.");
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
      `${missing} missing folder${missing === 1 ? "" : "s"}: registration only.`,
    );
  const briefly = (row) => {
    const gravest = ["nested", "submodules", "operation", "refs", "changes", "unchecked", "ignored"]
      .filter((name) => lossesOf(row).includes(name))
      .map((name) => LOSSES[name].brief);
    return gravest.length > 2
      ? `${gravest.slice(0, 2).join(", ")}, +${gravest.length - 2} more`
      : gravest.join(", ");
  };
  // What the last scan saw in a row that this operation will discard. It
  // decides which paths the preview shows first, so a selection's risky
  // members are never the ones hidden behind "and more".
  const risk = (row) =>
    !usesDiscardLocal(row, discardLocal)
      ? ""
      : briefly(row) ||
        (row.locked && !row.missing && !row.empty ? "locked" : "");
  // Worktrees that would lose commits or a repository come before those
  // that would lose files, and those before the rest.
  // (The list above the paths names every loss in full. Beside a path, the
  // two gravest are enough, and leave the path room to be recognized.)
  const weight = (row) =>
    !risk(row) ? 0 : unclean.includes(row) && graveLosses(row).length ? 2 : 1;
  if (trees.some((row) => row.locked && usesDiscardLocal(row, discardLocal)))
    notes.push(
      trees.length === 1 ? "Lock overridden." : "Locks overridden.",
    );
  const preview = trees
    .map((row, index) => ({ row, index, risk: risk(row) }))
    .sort((a, b) => weight(b.row) - weight(a.row) || a.index - b.index)
    .slice(0, 5)
    .map(({ row, risk }) => {
      const suffix = trees.length > 1 && risk ? ` — ${risk}` : "";
      return (
        shorten(
          hosts.size > 1
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
  const single = trees.length === 1;
  const losses = ordinary.map((name) => LOSSES[name].brief).join(" and ");
  return {
    title: registrationsOnly ? "Remove registration?" : "Delete worktrees?",
    message: single
      ? registrationsOnly ? `Remove registration for “${name}”?`
        : `Delete “${name}”${losses ? ` and its ${losses}` : ""}?`
      : `${registrationsOnly ? "Remove" : "Delete"} ${trees.length} ${registrationsOnly ? "missing worktree registrations" : "worktrees"}${hosts.size > 1 ? ` on ${hosts.size} hosts` : ""}?`,
    detail: `${notes.join("\n")}\n\n${preview.join("\n")}`,
    buttons: ["Cancel", registrationsOnly ? "Remove Registration" : "Delete",
      ...(single && unclean.length ? ["Show Files…"] : [])],
  };
}

module.exports = { removalConfirmationOptions };
