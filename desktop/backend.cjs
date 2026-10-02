"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const { StringDecoder } = require("node:string_decoder");

const MAX_OUTPUT = 64 * 1024 * 1024;
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*$/;
const PROGRESS_PREFIX = "@arbor-progress ";
const MAX_PROGRESS_LINE = 65536;
const MAX_PARTIAL_WORKTREES = 20000;
const DEFAULT_EXCLUDES = [
  ".cache",
  ".Trash",
  "node_modules",
  "tmp",
  "temp",
  "~/Library/Caches",
  "~/Library/Logs",
  "~/.local/share/Trash",
  "~/.codex/.tmp",
];

function partialWorktree(value, pending) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.path !== "string" ||
    !value.path ||
    value.path.length > 4096 ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 4096
  )
    return null;
  const result = {
    canRemove: false,
    recommended: false,
    pending: pending !== false,
  };
  for (const key of [
    "id",
    "path",
    "repo",
    "commonDir",
    "branch",
    "head",
    "subject",
    "author",
    "commitAt",
    "activityAt",
    "lockReason",
    "upstream",
    "defaultRef",
    "mergeReason",
    "githubState",
  ])
    result[key] =
      typeof value[key] === "string" ? value[key].slice(0, 4096) : "";
  for (const key of ["sizeBytes", "changedFiles", "ahead", "behind"])
    result[key] =
      Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : 0;
  for (const key of [
    "main",
    "bare",
    "detached",
    "locked",
    "missing",
    "outsideRoot",
    "dirty",
    "ignored",
    "published",
    "merged",
  ])
    result[key] = value[key] === true;
  for (const key of ["publishedRefs", "blockers", "problems"])
    result[key] = Array.isArray(value[key])
      ? value[key]
          .slice(0, 100)
          .filter((item) => typeof item === "string")
          .map((item) => item.slice(0, 4096))
      : [];
  if (
    value.pr &&
    typeof value.pr === "object" &&
    Number.isSafeInteger(value.pr.number)
  ) {
    result.pr = { number: value.pr.number, merged: value.pr.merged === true };
    for (const key of ["url", "title", "state"])
      result.pr[key] =
        typeof value.pr[key] === "string" ? value.pr[key].slice(0, 4096) : "";
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
  const host = text(value.host ?? "", "SSH host", 255);
  if (host && !HOST.test(host))
    throw new Error("Use an SSH host alias or user@hostname");
  const excludes =
    value.excludes === undefined ? DEFAULT_EXCLUDES : value.excludes;
  if (!Array.isArray(excludes) || excludes.length > 100)
    throw new Error("Choose up to 100 excluded folders");
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

function childEnvironment(platform = process.platform) {
  const env = { ...process.env };
  if (platform === "darwin")
    env.PATH = `${env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return env;
}

function execute(
  binary,
  args,
  {
    env = childEnvironment(),
    timeout = 20 * 60 * 1000,
    onChild = () => {},
    onDone = () => {},
    onProgress,
    signal,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    onChild(child);
    let stdout = [],
      stderr = [],
      size = 0,
      failure,
      settled = false,
      forceTimer;
    const decoder = new StringDecoder("utf8");
    let pendingStderr = "",
      oversizedLine = false;
    const stderrLine = (line) => {
      if (
        onProgress &&
        line.length <= MAX_PROGRESS_LINE &&
        line.startsWith(PROGRESS_PREFIX)
      ) {
        try {
          const event = progressEvent(
            JSON.parse(line.slice(PROGRESS_PREFIX.length)),
          );
          if (event) {
            onProgress(event);
            return;
          }
        } catch {
          /* Preserve malformed protocol data as diagnostic output. */
        }
      }
      stderr.push(Buffer.from(line));
    };
    const consumeStderr = (chunk, end = false) => {
      pendingStderr += end ? decoder.end() : decoder.write(chunk);
      let newline;
      while ((newline = pendingStderr.indexOf("\n")) !== -1) {
        const line = pendingStderr.slice(0, newline + 1);
        if (oversizedLine) stderr.push(Buffer.from(line));
        else stderrLine(line);
        pendingStderr = pendingStderr.slice(newline + 1);
        oversizedLine = false;
      }
      if (pendingStderr.length > MAX_PROGRESS_LINE || end) {
        if (end && !oversizedLine && pendingStderr.length <= MAX_PROGRESS_LINE)
          stderrLine(pendingStderr);
        else stderr.push(Buffer.from(pendingStderr));
        pendingStderr = "";
        oversizedLine = !end;
      }
    };
    const stop = (error) => {
      if (failure) return;
      failure = error;
      const kill = (name) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, name);
          else child.kill(name);
        } catch (error) {
          if (error.code !== "ESRCH") child.kill(name);
        }
      };
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 2000);
      forceTimer.unref();
    };
    const timer = setTimeout(
      () => stop(new Error("Arbor operation timed out")),
      timeout,
    );
    timer.unref();
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        stop(new Error("Arbor output exceeded its size limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        stop(new Error("Arbor output exceeded its size limit"));
        return;
      }
      consumeStderr(chunk);
    });
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      onDone(child);
      error ? reject(error) : resolve(output);
    };
    child.once("error", (error) =>
      finish(new Error(`Cannot start Arbor CLI: ${error.message}`)),
    );
    child.once("close", (code, signal) => {
      consumeStderr(null, true);
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (failure) return finish(failure);
      if (code !== 0)
        return finish(
          new Error(detail || `Arbor CLI exited ${signal || code}`),
        );
      finish(null, Buffer.concat(stdout).toString("utf8"));
    });
    const abort = () => stop(new Error("Arbor scan stopped"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
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
  const ids = new Set();
  for (const w of report.worktrees) {
    if (
      !w ||
      typeof w.id !== "string" ||
      !w.id ||
      ids.has(w.id) ||
      typeof w.path !== "string" ||
      typeof w.head !== "string" ||
      typeof w.branch !== "string"
    )
      throw new Error("Arbor CLI returned invalid worktree metadata");
    ids.add(w.id);
  }
  return report;
}

class Backend {
  constructor({
    binary,
    version = "dev",
    platform = process.platform,
    githubAvailable = false,
    run,
    root = "",
    host = "",
    options,
    setupRequired = false,
  }) {
    this.children = new Set();
    this.operation = null;
    this.partialPaths = new Map();
    this.options = scanOptions(options || { root, host });
    this.state = {
      report: null,
      busy: false,
      error: "",
      root: this.options.root,
      host: this.options.host,
      options: { ...this.options },
      setupRequired,
      progress: null,
      partialWorktrees: [],
      cancelled: false,
      cancelRequested: false,
      canCancelScan: false,
      version,
      revision: null,
      githubAvailable,
      platform,
    };
    this.run =
      run ||
      ((args, callbacks = {}) =>
        execute(binary, args, {
          env: childEnvironment(platform),
          onChild: (c) => this.children.add(c),
          onDone: (c) => this.children.delete(c),
          ...callbacks,
        }));
    this.pending = Promise.resolve();
    this.disposed = false;
  }

  getState() {
    return structuredClone(this.state);
  }

  async readReport(options) {
    const args = [
      "list",
      "--json",
      "--progress",
      "--path",
      options.root || (options.host ? "~" : os.homedir()),
    ];
    if (options.host) args.push("--host", options.host);
    if (options.github) args.push("--github");
    if (options.fetch) args.push("--fetch");
    args.push("--no-default-excludes");
    for (const excluded of options.excludes) args.push("--exclude", excluded);
    return parseReport(
      await this.run(args, {
        ...(this.operation === "scan"
          ? { signal: this.scanController.signal }
          : {}),
        onProgress: (value) => {
          const event = progressEvent(value);
          if (!this.disposed && !this.state.cancelRequested && event) {
            const { worktree, pending: _pending, ...status } = event;
            if (worktree) {
              const index = this.partialPaths.get(worktree.path);
              if (index !== undefined)
                this.state.partialWorktrees[index] = worktree;
              else if (
                this.state.partialWorktrees.length < MAX_PARTIAL_WORKTREES
              ) {
                this.partialPaths.set(
                  worktree.path,
                  this.state.partialWorktrees.length,
                );
                this.state.partialWorktrees.push(worktree);
              }
            }
            this.state.progress = {
              ...status,
              startedAt: this.state.progress?.startedAt || Date.now(),
            };
          }
        },
      }),
    );
  }

  beginProgress(stage = "starting") {
    this.state.partialWorktrees = [];
    this.partialPaths.clear();
    this.state.progress = {
      stage,
      path: this.options.root,
      discovered: 0,
      completed: 0,
      total: 0,
      startedAt: Date.now(),
    };
  }

  scan(value = {}) {
    if (this.disposed) throw new Error("Arbor is closing");
    if (this.state.setupRequired)
      throw new Error("Complete setup before scanning");
    if (this.state.busy) throw new Error("An operation is already running");
    this.options = scanOptions(value);
    Object.assign(this.state, {
      report: null,
      busy: true,
      error: "",
      root: this.options.root,
      host: this.options.host,
      revision: null,
      options: { ...this.options },
      cancelled: false,
      cancelRequested: false,
      canCancelScan: true,
    });
    this.beginProgress();
    this.operation = "scan";
    this.scanController = new AbortController();
    const options = { ...this.options };
    this.pending = this.readReport(options)
      .then((report) => {
        if (this.disposed || this.state.cancelRequested) return;
        Object.assign(this.state, {
          report,
          root: report.root,
          revision: randomUUID(),
        });
      })
      .catch((error) => {
        if (!this.disposed && !this.state.cancelRequested)
          this.state.error = error.message;
      })
      .finally(() => {
        this.state.busy = false;
        this.operation = null;
        this.state.canCancelScan = false;
        this.state.cancelled = this.state.cancelRequested;
        this.state.cancelRequested = false;
        this.scanController = null;
        if (this.state.cancelled && this.state.progress)
          this.state.progress.finishedAt = Date.now();
        if (!this.state.cancelled) {
          this.state.progress = null;
          this.state.partialWorktrees = [];
          this.partialPaths.clear();
        }
      });
    return this.getState();
  }

  cancelScan() {
    if (this.operation !== "scan" || !this.state.busy)
      throw new Error("No cancellable scan is running");
    this.state.cancelRequested = true;
    this.state.canCancelScan = false;
    this.scanController.abort();
    return this.getState();
  }

  reset() {
    if (this.disposed) throw new Error("Arbor is closing");
    if (this.state.busy || this.operation)
      throw new Error(
        "Wait for the current operation to stop before resetting",
      );
    this.options = scanOptions();
    this.partialPaths.clear();
    this.scanController = null;
    Object.assign(this.state, {
      report: null,
      busy: false,
      error: "",
      root: this.options.root,
      host: this.options.host,
      options: { ...this.options },
      setupRequired: true,
      progress: null,
      partialWorktrees: [],
      cancelled: false,
      cancelRequested: false,
      canCancelScan: false,
      revision: null,
    });
    return this.getState();
  }

  async remove(value, confirm) {
    if (this.disposed) throw new Error("Arbor is closing");
    if (this.state.busy) throw new Error("An operation is already running");
    if (
      !value ||
      typeof value !== "object" ||
      !this.state.revision ||
      value.revision !== this.state.revision
    )
      throw new Error(
        "The scan changed; review the current worktrees and try again",
      );
    if (
      !Array.isArray(value.items) ||
      !value.items.length ||
      value.items.length > 1000
    )
      throw new Error("Choose between 1 and 1000 worktrees");
    const selected = [],
      seen = new Set();
    for (const item of value.items) {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.head !== "string" ||
        seen.has(item.id)
      )
        throw new Error("Invalid worktree selection");
      const w = this.state.report.worktrees.find(
        (entry) => entry.id === item.id,
      );
      if (!w || w.head !== item.head || !w.canRemove || w.outsideRoot)
        throw new Error("Worktree changed or is protected; scan again");
      if (value.recommendedOnly === true && !w.recommended)
        throw new Error("Worktree is not a cleanup recommendation");
      selected.push(structuredClone(w));
      seen.add(item.id);
    }
    this.state.busy = true;
    this.state.error = "";
    this.operation = "remove";
    this.beginProgress("removing");
    const options = { ...this.options },
      results = [];
    const perform = async () => {
      try {
        const manual = selected.filter((w) => !w.recommended);
        if (manual.length && (!confirm || !(await confirm(manual))))
          return {
            cancelled: true,
            results,
            report: this.state.report,
            revision: this.state.revision,
          };
        this.state.revision = null;
        for (const w of selected) {
          const args = [
            "remove",
            "--yes",
            "--json",
            "--head",
            w.head,
            "--id",
            w.id,
            "--branch",
            w.branch,
          ];
          if (options.host) args.push("--host", options.host);
          if (w.pr?.merged) args.push("--github");
          if (value.recommendedOnly === true || w.recommended)
            args.push("--recommended-only");
          args.push("--", w.path);
          try {
            const result = JSON.parse(await this.run(args));
            if (!result || result.path !== w.path || result.removed !== true)
              throw new Error(result?.error || "Arbor did not confirm removal");
            results.push({ path: w.path, removed: true });
          } catch (error) {
            results.push({
              path: w.path,
              removed: false,
              error: error.message,
            });
          }
        }
        try {
          this.beginProgress("starting");
          this.state.report = null;
          const report = await this.readReport({ ...options, fetch: false });
          Object.assign(this.state, {
            report,
            root: report.root,
            revision: randomUUID(),
          });
        } catch (error) {
          this.state.error = `Cleanup finished, but refreshing failed: ${error.message}`;
        }
        return {
          results,
          report: structuredClone(this.state.report),
          revision: this.state.revision,
          error: this.state.error,
        };
      } finally {
        this.state.busy = false;
        this.operation = null;
        this.state.progress = null;
        this.state.partialWorktrees = [];
        this.partialPaths.clear();
      }
    };
    this.pending = perform();
    return this.pending;
  }

  dispose() {
    if (this.operation === "remove") return false;
    this.disposed = true;
    this.scanController?.abort();
    for (const child of this.children) child.kill("SIGTERM");
    return true;
  }
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
      name: text(item.name || host, "host name", 100),
      host,
      root: text(item.root ?? "~", "remote folder"),
    };
  });
  const roots = value.roots ?? [];
  if (!Array.isArray(roots) || roots.length > 100)
    throw new Error("Invalid recent folders");
  return {
    theme,
    hosts,
    roots: roots.map((root) => text(root, "recent folder")),
    setupCompleted: value.setupCompleted === true,
    exclusionDefaultsVersion: 1,
    scan: scanOptions(value.scan || { root: roots[0] || "" }),
  };
}

function loadPreferences(value) {
  const preferences = validatePreferences(value);
  // Upgrade untouched v0.1.2/v0.1.3 defaults, not custom exclusions or an
  // explicitly empty list. The marker lets users remove the new rule later.
  const previousDefaults = DEFAULT_EXCLUDES.filter(
    (rule) => rule !== "~/.codex/.tmp",
  );
  const saved = preferences.scan.excludes;
  if (
    !value.exclusionDefaultsVersion &&
    saved.length === previousDefaults.length &&
    new Set(saved).size === previousDefaults.length &&
    previousDefaults.every((rule) => saved.includes(rule))
  ) {
    preferences.scan.excludes = [...DEFAULT_EXCLUDES];
  }
  return preferences;
}

module.exports = {
  Backend,
  execute,
  parseReport,
  scanOptions,
  validatePreferences,
  loadPreferences,
  childEnvironment,
};
