"use strict";

const { MAX_WORKTREES } = require("./protocol.cjs");

// Pure consent and CLI contract. This module neither starts operations nor
// changes reports; the backend owns those lifetimes and mutations.
function usesDiscardLocal(row, discardLocal) {
  return discardLocal === true && !row.canRemove;
}

function planRemoval(state, request) {
  if (
    !request ||
    typeof request !== "object" ||
    !state.revision ||
    request.revision !== state.revision
  )
    throw new Error(
      "The scan changed; review the current worktrees and try again",
    );
  // Anything one scan can list, one confirmed selection can remove.
  if (
    !Array.isArray(request.items) ||
    !request.items.length ||
    request.items.length > MAX_WORKTREES
  )
    throw new Error("Choose at least one worktree");
  const discardLocal = request.discardLocal === true;
  const recommendedOnly = request.recommendedOnly === true;
  if (discardLocal && recommendedOnly)
    throw new Error(
      "Discarding local data cannot be a recommended-only cleanup",
    );
  const rows = new Map(state.report.worktrees.map((row) => [row.id, row]));
  const selected = [],
    ids = new Set(),
    paths = new Set();
  for (const item of request.items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.head !== "string" ||
      ids.has(item.id)
    )
      throw new Error("Invalid worktree selection");
    const row = rows.get(item.id);
    if (
      !row ||
      row.head !== item.head ||
      !(row.canRemove || (discardLocal && row.canDiscard)) ||
      row.outsideRoot
    )
      throw new Error("Worktree changed or is protected; scan again");
    if (recommendedOnly && !row.recommended)
      throw new Error("Worktree is not a cleanup recommendation");
    ids.add(item.id);
    // Several repositories can retain registrations for one physical folder.
    // One consent must never remove that folder or count its bytes twice.
    if (!paths.has(row.path)) selected.push(structuredClone(row));
    paths.add(row.path);
  }
  return {
    selected,
    discardLocal,
    recommendedOnly,
    confirmation:
      discardLocal || request.forceConfirm === true
        ? selected
        : selected.filter((row) => !row.recommended),
  };
}

function removalArguments(
  row,
  { host, statsSession, discardLocal, recommendedOnly },
) {
  const args = [
    "remove",
    "--yes",
    "--json",
    "--stats-session",
    statsSession,
    "--head",
    row.head,
    "--id",
    row.id,
    "--branch",
    row.branch,
  ];
  if (row.commonDir) args.push("--repo", row.commonDir);
  if (row.missing) args.push("--expect-missing");
  if (row.empty) args.push("--expect-empty");
  if (host) args.push("--host", host);
  if (row.pr?.merged) args.push("--github");
  args.push(
    usesDiscardLocal(row, discardLocal) ? "--discard-local" : "--keep-local",
  );
  if (recommendedOnly) args.push("--recommended-only");
  args.push("--", row.path);
  return args;
}

function removalFailure(error, requestedPath) {
  if (typeof error?.stdout === "string" && error.stdout.length <= 65536) {
    try {
      const value = JSON.parse(error.stdout);
      const rows = Array.isArray(value) ? value : [value];
      if (rows.length <= 1000) {
        const matches = rows.filter((row) => row && row.path === requestedPath);
        if (
          matches.length === 1 &&
          matches[0].removed === false &&
          typeof matches[0].error === "string" &&
          matches[0].error.trim() &&
          matches[0].error.length <= 8192 &&
          !matches[0].error.includes("\0")
        )
          return matches[0].error;
      }
    } catch {
      /* Unknown output keeps the runner's bounded failure contract. */
    }
  }
  return error?.message || "Worktree removal failed";
}

module.exports = {
  usesDiscardLocal,
  planRemoval,
  removalArguments,
  removalFailure,
};
