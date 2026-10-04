"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const MAX_ENTRIES = 20;
const MAX_BYTES = 32 * 1024 * 1024;

function identity(options) {
  const host = options.host || "";
  let root = options.root || (host ? "~" : os.homedir());
  if (!host) {
    if (root === "~" || root.startsWith("~/"))
      root = os.homedir() + root.slice(1);
    root = path.resolve(root);
  } else root = path.posix.normalize(root);
  return {
    host,
    root,
    github: options.github === true,
    fetch: options.fetch === true,
    excludes: [...new Set(options.excludes || [])].sort(),
  };
}

function cacheKey(options) {
  return JSON.stringify(identity(options));
}

function validReport(report) {
  return (
    report &&
    typeof report.root === "string" &&
    Array.isArray(report.warnings) &&
    Array.isArray(report.worktrees) &&
    report.worktrees.length <= 20000 &&
    report.worktrees.every(
      (row) =>
        row &&
        ["id", "path", "head", "branch"].every(
          (key) => typeof row[key] === "string",
        ),
    )
  );
}

function persistentReport(report) {
  // A failed targeted inspection is live operation state, not a reusable
  // snapshot. Never restore older permissive flags or an indefinitely blocked
  // failure row. A later successful inspection can cache this workspace again.
  if (report.worktrees.some((row) => row.retryInspection === true)) return null;
  const snapshot = structuredClone(report);
  for (const row of snapshot.worktrees) {
    delete row.lastRemovalError;
    delete row.retryInspection;
    delete row.inspectionError;
  }
  return snapshot;
}

class WorkspaceCache {
  constructor({
    filename,
    maxEntries = MAX_ENTRIES,
    maxBytes = MAX_BYTES,
  } = {}) {
    this.filename = filename;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.pending = Promise.resolve();
    this.lastError = null;
  }

  static async open(filename, options = {}) {
    const cache = new WorkspaceCache({ ...options, filename });
    await cache.load();
    return cache;
  }

  async load() {
    if (!this.filename) return;
    try {
      if ((await fs.stat(this.filename)).size > this.maxBytes) return;
      const data = JSON.parse(await fs.readFile(this.filename, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.entries)) return;
      for (const entry of data.entries.slice(-this.maxEntries)) {
        if (!entry || !entry.options || !validReport(entry.report)) continue;
        const report = persistentReport(entry.report);
        if (!report) continue;
        const options = identity(entry.options);
        const roots = [
          options.root,
          entry.report.root,
          ...(Array.isArray(entry.roots) ? entry.roots : []),
        ]
          .filter((root) => typeof root === "string" && root.length <= 4096)
          .slice(0, 20);
        this.entries.set(cacheKey(options), {
          options,
          roots,
          report,
        });
      }
    } catch {
      // A missing or corrupt cache is just a cache miss, never lost Git data.
      this.entries.clear();
    }
  }

  get(options) {
    const key = cacheKey(options);
    let matchedKey = key;
    let entry = this.entries.get(key);
    if (!entry) {
      // Git resolves ~ and symlinks in the report. Accept that same canonical
      // root without conflating SSH hosts or any inspection options.
      for (const [candidateKey, candidate] of this.entries) {
        if (
          candidate.roots.some(
            (root) => cacheKey({ ...candidate.options, root }) === key,
          )
        ) {
          matchedKey = candidateKey;
          entry = candidate;
          break;
        }
      }
    }
    if (!entry) return null;
    this.entries.delete(matchedKey);
    this.entries.set(matchedKey, entry);
    this.persist();
    return structuredClone(entry.report);
  }

  put(options, report) {
    if (!validReport(report)) return;
    const normalized = identity(options);
    const key = cacheKey(normalized);
    const canonical = cacheKey({ ...normalized, root: report.root });
    const roots = new Set([normalized.root, report.root]);
    for (const [candidateKey, candidate] of this.entries) {
      if (
        candidateKey === key ||
        cacheKey({ ...candidate.options, root: candidate.report.root }) ===
          canonical
      ) {
        candidate.roots.forEach((root) => roots.add(root));
        this.entries.delete(candidateKey);
      }
    }
    this.entries.delete(key);
    const snapshot = persistentReport(report);
    if (!snapshot) {
      this.persist();
      return;
    }
    this.entries.set(key, {
      options: normalized,
      roots: [...roots].slice(0, 20),
      report: snapshot,
    });
    this.trim();
    this.persist();
  }

  removePaths(host, paths) {
    const removed = new Set(paths.map((value) => path.posix.normalize(value)));
    for (const entry of this.entries.values()) {
      if (entry.options.host !== (host || "")) continue;
      // Removing a parent checkout does not remove nested Git registrations.
      // Their own entries remain reviewable, even if their folders are missing.
      entry.report.worktrees = entry.report.worktrees.filter(
        (row) => !removed.has(path.posix.normalize(row.path)),
      );
    }
    this.persist();
  }

  clear() {
    this.entries.clear();
    this.persist();
  }

  serialize() {
    return JSON.stringify({ version: 1, entries: [...this.entries.values()] });
  }

  trim() {
    while (
      this.entries.size > this.maxEntries ||
      Buffer.byteLength(this.serialize()) > this.maxBytes
    ) {
      if (!this.entries.size) break;
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  persist() {
    if (!this.filename) return this.pending;
    this.writeRequested = true;
    if (this.writing) return this.pending;
    this.writing = true;
    this.pending = this.pending.then(async () => {
      try {
        while (this.writeRequested) {
          this.writeRequested = false;
          const temporary = `${this.filename}.${randomUUID()}.tmp`;
          try {
            await fs.mkdir(path.dirname(this.filename), {
              recursive: true,
              mode: 0o700,
            });
            await fs.writeFile(temporary, this.serialize(), {
              mode: 0o600,
              flag: "wx",
            });
            await fs.rename(temporary, this.filename);
            this.lastError = null;
          } catch (error) {
            this.lastError = error;
            await fs.unlink(temporary).catch(() => {});
          }
        }
      } finally {
        this.writing = false;
      }
    });
    return this.pending;
  }
}

module.exports = { WorkspaceCache, cacheKey };
