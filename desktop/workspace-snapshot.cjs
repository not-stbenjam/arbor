"use strict";

const { randomUUID } = require("node:crypto");

const globalID = (host, id) =>
  Buffer.from(JSON.stringify([host, id])).toString("base64url");
function parseGlobalID(value) {
  if (typeof value !== "string" || value.length > 8192)
    throw new Error("Invalid worktree identity");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid worktree identity");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((value) => typeof value !== "string") ||
    globalID(...parsed) !== value
  )
    throw new Error("Invalid worktree identity");
  return { host: parsed[0], id: parsed[1] };
}

class SnapshotRevisions {
  #history = new Map();
  #signature;
  #current;
  capture(hosts) {
    const values = hosts.map((host) => [host.host, host.revision]);
    const signature = JSON.stringify(values);
    if (signature !== this.#signature) {
      this.#signature = signature;
      this.#current = randomUUID();
      this.#history.set(this.#current, new Map(values));
      while (this.#history.size > 128)
        this.#history.delete(this.#history.keys().next().value);
    }
    return this.#current;
  }
  native(revision, host) {
    const revisions = this.#history.get(revision);
    if (!revisions?.has(host))
      throw new Error("The worktree list changed; review it and try again");
    return revisions.get(host);
  }
  clear() {
    this.#history.clear();
    this.#signature = undefined;
    this.#current = undefined;
  }
}

function* sourceRows(state) {
  const checked = state.report?.worktrees || [];
  const ids = new Set(checked.map((row) => row.id));
  const paths = new Set(checked.map((row) => row.path));
  for (const row of checked) yield [row, false];
  for (const row of state.partialWorktrees || []) {
    if (!row.commonDir && paths.has(row.path)) continue;
    if (!ids.has(row.id)) {
      ids.add(row.id);
      paths.add(row.path);
      yield [row, true];
    }
  }
}

function displayedRows(state) {
  return Array.from(sourceRows(state), ([row, pending]) => ({
    ...row,
    pending,
    nativeRevision: pending ? null : state.revision,
    ...(pending
      ? { canRemove: false, canDiscard: false, recommended: false }
      : {}),
    id: globalID(state.host, row.id),
    sourceID: row.id,
    host: state.host,
    hostLabel: state.label,
  }));
}

// Per-host summaries carry scan metadata, not a second copy of every checkout.
// The selected aggregate report is the renderer's only worktree collection.
function hostSummary(state) {
  const { report, partialWorktrees, ...summary } = state;
  let metadata = null;
  if (report) {
    const { worktrees, warnings, ...rest } = report;
    metadata = rest;
  }
  let worktreeCount = 0;
  for (const _row of sourceRows(state)) worktreeCount++;
  return { ...summary, report: metadata, worktreeCount };
}

function workspaceSnapshot(
  hosts,
  { hostFilter, revision, setupRequired, removing },
) {
  const visible =
    hostFilter === null
      ? hosts
      : hosts.filter((host) => host.host === hostFilter);
  const summaries = hosts.map(hostSummary);
  const base =
    summaries.find((host) => host.host === visible[0]?.host) || summaries[0];
  const report = mergedReport(hosts, hostFilter);
  const active = visible.some((host) => host.busy);
  const messages = (key) =>
    visible
      .filter((host) => host[key])
      .map((host) =>
        hostFilter === null ? `${host.label}: ${host[key]}` : host[key],
      )
      .join("\n");
  return {
    ...base,
    hosts: summaries,
    hostFilter,
    host: hostFilter || "",
    // The combined view spans machines and has no scan folder of its own.
    root: hostFilter === null ? "" : base.root,
    report,
    worktreeCount: report?.worktrees.length || 0,
    revision,
    setupRequired,
    busy: active || removing,
    removing,
    operation: removing ? "remove" : active ? "scan" : null,
    progress: hostFilter === null ? null : base.progress,
    canCancelScan: visible.some((host) => host.canCancelScan),
    cancelled: visible.some((host) => host.cancelled),
    cached: visible.length > 0 && visible.every((host) => host.cached),
    error: messages("error"),
    warning: messages("warning"),
  };
}

function mergedReport(hosts, filter) {
  const visible =
    filter === null ? hosts : hosts.filter((state) => state.host === filter);
  if (!visible.some((state) => state.report || state.partialWorktrees.length))
    return null;
  return {
    root: filter === null ? "" : visible[0]?.root || "",
    worktrees: visible.flatMap(displayedRows),
    warnings: visible.flatMap((state) =>
      (state.report?.warnings || []).map((warning) =>
        filter === null ? `${state.label}: ${warning}` : warning,
      ),
    ),
    scannedAt:
      visible
        .map((state) => state.report?.scannedAt)
        .filter(Boolean)
        .sort()
        .at(0) || null,
    durationMs: visible.reduce(
      (sum, state) => sum + (state.report?.durationMs || 0),
      0,
    ),
    github: visible.every((state) => state.report?.github),
    fetched: visible.every((state) => state.report?.fetched),
  };
}

module.exports = {
  globalID,
  parseGlobalID,
  SnapshotRevisions,
  displayedRows,
  mergedReport,
  workspaceSnapshot,
};
