"use strict";

const { randomUUID } = require("node:crypto");
const os = require("node:os");
const { WorkspaceCache, cacheKey } = require("./workspace-cache.cjs");
const { planRemoval } = require("./removal-policy.cjs");
const { executeCleanupBatch } = require("./cleanup-batch.cjs");
const {
  scanOptions,
  parseReport,
  parseFiles,
  progressEvent,
  MAX_WORKTREES,
} = require("./protocol.cjs");
const { execute, childEnvironment } = require("./process-runner.cjs");
const { LiveWorktrees } = require("./live-worktrees.cjs");
const { displayedRows } = require("./workspace-snapshot.cjs");
const { menuTarget } = require("./worktree-menu.cjs");
const { RecentDeletions } = require("./recent-deletions.cjs");
const { lossesOf } = require("./common/losses.mjs");

// Why the command line would not put a worktree back, in its own words where
// it gave them for this path; otherwise what running it reported.
function restoreFailure(error, requestedPath) {
  try {
    if (typeof error.stdout === "string" && error.stdout.length <= 65536) {
      const result = JSON.parse(error.stdout);
      if (
        result.path === requestedPath &&
        result.restored === false &&
        typeof result.error === "string"
      )
        return result.error;
    }
  } catch {
    // Keep the runner's diagnostic for unknown output.
  }
  return error.message || "Could not restore";
}

class Backend {
  #cache;
  #deletions;
  #run;
  #live = new LiveWorktrees(MAX_WORKTREES);
  #scanController;
  #targetInspectionController;
  #stopAfterCurrent;
  // Asked for from the window: the rest of a deletion is left alone, and
  // the application stays open.
  #stopRequested = false;
  #state;
  #operation;
  #pending;
  #options;
  #disposed;
  #transition = null;
  #transitionPending = Promise.resolve();
  #transitionController;
  #lifecycleGeneration = 0;
  #readers = new Map();
  constructor({
    binary,
    version = "dev",
    platform = process.platform,
    githubAvailable = false,
    run,
    root = "",
    host = "",
    options,
    cache = new WorkspaceCache(),
    deletions = new RecentDeletions(),
  }) {
    this.#cache = cache;
    this.#deletions = deletions;
    this.#operation = null;
    this.#options = scanOptions(options || { root, host });
    this.#state = {
      report: null,
      busy: false,
      error: "",
      warning: "",
      root: this.#options.root,
      host: this.#options.host,
      options: { ...this.#options },
      progress: null,
      cancelled: false,
      cancelRequested: false,
      canCancelScan: false,
      version,
      revision: null,
      cached: false,
      githubAvailable,
      platform,
    };
    this.#run =
      run ||
      ((args, callbacks = {}) =>
        execute(binary, args, {
          env: childEnvironment(platform),
          ...callbacks,
        }));
    this.#pending = Promise.resolve();
    this.#disposed = false;
  }

  getState() {
    return {
      ...structuredClone(this.#state),
      partialWorktrees: structuredClone(this.#live.rows),
      operation: this.#operation,
      canStopRemoval:
        this.#operation === "remove" &&
        !this.#stopRequested &&
        !this.#stopAfterCurrent,
      stopRequested: this.#operation === "remove" && this.#stopRequested,
      canCancelScan:
        this.#state.canCancelScan ||
        (this.#transition === "workspace" &&
          !this.#transitionController?.signal.aborted),
    };
  }

  assertInteractive() {
    if (this.#disposed) throw new Error("Arbor is closing");
    if (this.#transition) throw new Error("An operation is already running");
  }

  async waitUntilIdle() {
    // Workspace preparation can start a scan while the caller is waiting.
    // Observe both promises until neither ownership token changes.
    for (;;) {
      const operation = this.#pending;
      const transition = this.#transitionPending;
      await Promise.allSettled([
        operation,
        transition,
        ...this.#readers.values(),
      ]);
      if (
        operation === this.#pending &&
        transition === this.#transitionPending &&
        this.#readers.size === 0
      )
        return this.getState();
    }
  }

  setGitHubAvailable(available) {
    this.#state.githubAvailable = available === true;
  }

  configureWorkspace(value, persist, { restore = false } = {}) {
    this.assertInteractive();
    if (this.#state.busy && (!restore || this.#operation !== "scan"))
      throw new Error("An operation is already running");
    const options = scanOptions(value);
    this.#transition = "workspace";
    const controller = new AbortController();
    this.#transitionController = controller;
    this.#transitionPending = (async () => {
      let warning = "";
      try {
        if (this.#state.busy) {
          this.#cancelScan();
          await this.#pending;
        }
        if (this.#disposed) throw new Error("Arbor is closing");
        try {
          await persist(structuredClone(options));
        } catch (error) {
          warning = `Could not save settings: ${String(error.message || error).slice(0, 1024)}. These choices will be used for this session.`;
        }
        this.#options = options;
      } finally {
        this.#transition = null;
        this.#transitionController = null;
      }
      if (this.#disposed) return this.getState();
      if (controller.signal.aborted) {
        this.#state.cancelRequested = false;
        this.#state.cancelled = true;
        this.#state.warning = warning;
        return this.getState();
      }
      if (restore) await this.#activateWorkspace(options);
      else this.#scan(options);
      this.#state.warning = warning;
      return this.getState();
    })();
    return this.#transitionPending;
  }

  requestClose({ finishCleanup = false } = {}) {
    if (this.#operation === "remove" && !finishCleanup)
      return Object.freeze({ action: "confirm-cleanup" });
    this.#lifecycleGeneration++;
    this.#disposed = true;
    this.#transitionController?.abort();
    for (const controller of this.#readers.keys()) controller.abort();
    if (this.#operation === "remove") this.#stopCleanupAfterCurrent();
    else {
      this.#scanController?.abort();
      this.#targetInspectionController?.abort();
    }
    return Object.freeze({
      action:
        this.#operation || this.#transition || this.#readers.size
          ? "wait"
          : "close",
    });
  }

  async reopen(value = this.#options, { activate = true } = {}) {
    const generation = ++this.#lifecycleGeneration;
    await this.waitUntilIdle();
    if (generation !== this.#lifecycleGeneration) return this.getState();
    this.#disposed = false;
    if (!activate) return this.getState();
    return this.#activateWorkspace(scanOptions(value));
  }

  async worktreeFiles(value, { signal, onProgress } = {}) {
    this.assertInteractive();
    const state = this.getState();
    // Use the same checked and newly discovered rows as the native menu.
    const rows = displayedRows(state).map((row) => ({
      ...row,
      id: row.sourceID,
    }));
    const target = menuTarget({ ...state, report: { worktrees: rows } }, value);
    const row = rows.find((row) => row.id === target.id);
    const args = ["files", "--json", "--progress"];
    if (row.commonDir) args.push("--repo", row.commonDir);
    if (this.#options.host) args.push("--host", this.#options.host);
    args.push("--", target.path);
    const controller = new AbortController();
    const reading = this.#run(args, {
      timeout: 60000,
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      onProgress: (value) => {
        const event = progressEvent(value);
        if (
          !signal?.aborted &&
          !controller.signal.aborted &&
          event &&
          (event.stage === "connecting" || event.stage.startsWith("files-"))
        )
          onProgress?.(event);
      },
    });
    this.#readers.set(controller, reading);
    try {
      const report = parseFiles(await reading);
      if (report.path !== target.path)
        throw new Error("The file inventory belongs to a different worktree");
      return report;
    } finally {
      this.#readers.delete(controller);
    }
  }

  async readStats() {
    this.assertInteractive();
    const host = this.#options.host;
    const args = ["stats", "--json"];
    if (host) args.push("--host", host);
    const controller = new AbortController();
    const reading = this.#run(args, {
      timeout: 30000,
      signal: controller.signal,
    });
    this.#readers.set(controller, reading);
    try {
      const report = JSON.parse(await reading);
      if (!report || report.version !== 1 || !Array.isArray(report.daily))
        throw new Error("Arbor returned invalid statistics");
      return { host, report };
    } finally {
      this.#readers.delete(controller);
    }
  }

  async #readReport(options) {
    const args = [
      "list",
      "--json",
      "--progress",
      "--linked-only",
      "--path",
      options.root || (options.host ? "~" : os.homedir()),
    ];
    if (options.host) args.push("--host", options.host);
    if (options.github) args.push("--github");
    if (options.fetch) args.push("--fetch");
    args.push("--no-default-excludes");
    for (const excluded of options.excludes) args.push("--exclude", excluded);
    return parseReport(
      await this.#run(args, {
        ...(this.#operation === "scan"
          ? { signal: this.#scanController.signal }
          : {}),
        onProgress: (value) => {
          const event = progressEvent(value);
          if (!this.#disposed && !this.#state.cancelRequested && event) {
            const { worktree, pending: _pending, ...status } = event;
            if (worktree)
              this.#live.update(
                worktree,
                event.stage === "discovery" && !worktree.commonDir,
              );
            this.#state.progress = {
              ...status,
              startedAt: this.#state.progress?.startedAt || Date.now(),
            };
          }
        },
      }),
    );
  }

  #beginProgress(stage = "starting") {
    this.#live.clear();
    this.#state.progress = {
      stage,
      path: this.#options.root,
      discovered: 0,
      completed: 0,
      total: 0,
      startedAt: Date.now(),
    };
  }

  async #activateWorkspace(value = {}) {
    this.assertInteractive();
    const options = scanOptions(value);
    if (this.#state.busy) {
      if (this.#operation !== "scan")
        throw new Error("An operation is already running");
      this.cancelScan();
      await this.#pending;
    }
    if (this.#disposed) throw new Error("Arbor is closing");
    if (this.#state.busy) throw new Error("An operation is already running");
    const report = this.#cache.get(options);
    if (!report) return this.#scan(options);
    this.#options = options;
    this.#live.clear();
    Object.assign(this.#state, {
      report,
      root: report.root,
      host: options.host,
      options: { ...options },
      busy: false,
      error: "",
      warning: "",
      revision: randomUUID(),
      cached: true,
      progress: null,
      cancelled: false,
      cancelRequested: false,
      canCancelScan: false,
    });
    return this.getState();
  }

  #scan(value = {}) {
    this.assertInteractive();
    if (this.#state.busy) throw new Error("An operation is already running");
    const options = scanOptions(value);
    const preserve =
      this.#state.report && cacheKey(options) === cacheKey(this.#state.options);
    this.#options = options;
    Object.assign(this.#state, {
      report: preserve ? this.#state.report : null,
      busy: true,
      error: "",
      warning: "",
      root: this.#options.root,
      host: this.#options.host,
      revision: preserve ? this.#state.revision : null,
      options: { ...this.#options },
      cancelled: false,
      cancelRequested: false,
      canCancelScan: true,
      cached: false,
    });
    this.#beginProgress();
    this.#operation = "scan";
    this.#scanController = new AbortController();
    this.#pending = this.#readReport(options)
      .then((report) => {
        if (this.#disposed || this.#state.cancelRequested) return;
        this.#cache.put(options, report);
        Object.assign(this.#state, {
          report,
          root: report.root,
          revision: randomUUID(),
        });
      })
      .catch((error) => {
        if (!this.#disposed && !this.#state.cancelRequested)
          this.#state.error = error.message;
      })
      .finally(async () => {
        await this.#cache.pending;
        this.#state.busy = false;
        this.#operation = null;
        this.#state.canCancelScan = false;
        this.#state.cancelled = this.#state.cancelRequested;
        this.#state.cancelRequested = false;
        this.#scanController = null;
        if (this.#state.cancelled && this.#state.progress)
          this.#state.progress.finishedAt = Date.now();
        if (!this.#state.cancelled) {
          this.#state.progress = null;
          this.#live.clear();
        }
      });
    return this.getState();
  }

  cancelScan() {
    if (!this.#disposed && this.#transition === "workspace") {
      this.#transitionController.abort();
      this.#state.cancelRequested = true;
      return this.getState();
    }
    this.assertInteractive();
    return this.#cancelScan();
  }

  #cancelScan() {
    if (this.#operation !== "scan" || !this.#state.busy)
      throw new Error("No cancellable scan is running");
    this.#state.cancelRequested = true;
    this.#state.canCancelScan = false;
    this.#scanController.abort();
    return this.getState();
  }

  async #refreshTarget(row, restored = false) {
    const args = [
      "list",
      "--target-only",
      "--linked-only",
      "--json",
      "--path",
      row.path,
    ];
    if (row.commonDir) args.push("--repo", row.commonDir);
    if (this.#options.host) args.push("--host", this.#options.host);
    if (this.#options.github) args.push("--github");
    const controller = new AbortController();
    this.#targetInspectionController = controller;
    try {
      const report = parseReport(
        await this.#run(args, { timeout: 30000, signal: controller.signal }),
      );
      if (this.#disposed) throw new Error("Inspection skipped while closing");
      if (restored) {
        const current = report.worktrees.find(
          (entry) =>
            entry.path === row.path && entry.commonDir === row.commonDir,
        );
        if (!current)
          throw new Error("Restored checkout was not found by inspection");
        if (!this.#state.report)
          this.#state.report = {
            ...report,
            root: this.#options.root,
            worktrees: [],
          };
        this.#state.report.worktrees = this.#state.report.worktrees.filter(
          (entry) => entry.id !== current.id,
        );
        this.#state.report.worktrees.push(current);
        return;
      }
      const current = report.worktrees.find((entry) => entry.id === row.id);
      const index = this.#state.report.worktrees.findIndex(
        (entry) => entry.id === row.id,
      );
      if (index < 0) return;
      if (
        !current &&
        !report.worktrees.some((entry) => entry.path === row.path)
      ) {
        // An external Git removal can unregister the target between scans.
        // Absence is not an inspection failure unless another identity now
        // occupies this path; never replace that different registration.
        this.#state.report.worktrees.splice(index, 1);
        this.#cache.removeIDs(this.#options.host, [row.id]);
        return;
      }
      if (!current || current.path !== row.path)
        throw new Error(
          "Worktree registration changed; targeted inspection returned a different identity",
        );
      this.#state.report.worktrees[index] = {
        ...current,
        retryInspection: false,
        ...(row.lastRemovalError
          ? { lastRemovalError: row.lastRemovalError }
          : {}),
      };
    } finally {
      if (this.#targetInspectionController === controller)
        this.#targetInspectionController = null;
    }
  }

  #markInspectionFailure(row, error) {
    row.canRemove = false;
    row.recommended = false;
    row.canDiscard = false;
    row.retryInspection = true;
    row.inspectionError = error.message;
    row.blockers = [
      ...(row.blockers || []).filter(
        (message) => !message.startsWith("Inspection failed:"),
      ),
      `Inspection failed: ${error.message}. Choose Check again from its menu.`,
    ];
  }

  inspectWorktree(value) {
    this.assertInteractive();
    if (this.#state.busy) throw new Error("An operation is already running");
    if (
      !value ||
      !this.#state.revision ||
      value.revision !== this.#state.revision ||
      typeof value.id !== "string"
    )
      throw new Error("The worktree list changed; try inspection again");
    const row = this.#state.report?.worktrees.find(
      (entry) => entry.id === value.id,
    );
    if (!row) throw new Error("Worktree is no longer in the current list");
    this.#state.busy = true;
    this.#state.error = "";
    this.#operation = "inspect";
    this.#beginProgress("inspect");
    this.#state.progress.path = row.path;
    this.#state.progress.total = 1;
    this.#state.revision = null;
    this.#pending = this.#refreshTarget(row)
      .catch((error) => {
        if (this.#disposed) return;
        this.#markInspectionFailure(row, error);
        this.#state.error = `Could not inspect ${row.path}: ${error.message}`;
      })
      .finally(async () => {
        if (!this.#disposed) this.#cache.put(this.#options, this.#state.report);
        await this.#cache.pending;
        this.#state.busy = false;
        this.#operation = null;
        this.#state.progress = null;
        this.#state.revision = this.#disposed ? null : randomUUID();
      });
    return this.getState();
  }

  async #reconcileRemoval(row, outcome) {
    if (outcome.removed) {
      this.#state.report.worktrees = this.#state.report.worktrees.filter(
        (entry) => entry.id !== row.id,
      );
      this.#cache.removeIDs(this.#options.host, [row.id]);
      for (const sibling of this.#state.report.worktrees.filter(
        (entry) => entry.path === row.path,
      ))
        await this.#inspectAfterCleanup(sibling);
      if (
        !outcome.missing &&
        row.commonDir &&
        row.head &&
        (row.branch || row.detached)
      ) {
        try {
          const entry = await this.#deletions.add({
            host: this.#options.host,
            path: row.path,
            repo: row.repo,
            commonDir: row.commonDir,
            branch: row.branch,
            head: row.head,
            detached: row.detached === true,
            retainedBranch: outcome.retainedBranch || "",
            sizeBytes: Math.max(0, row.sizeBytes || 0),
            clean: lossesOf(row).length === 0,
          });
          return { restoreID: entry.id, clean: entry.clean };
        } catch (error) {
          return {
            historyError: `Could not remember deletion: ${error.message}`,
          };
        }
      }
      return;
    }
    const entry = this.#state.report.worktrees.find(
      (item) => item.id === row.id,
    );
    if (!entry) return;
    entry.lastRemovalError = outcome.error;
    const inspectionError = await this.#inspectAfterCleanup(entry);
    return inspectionError ? { inspectionError } : undefined;
  }

  restore(entry) {
    this.assertInteractive();
    if (this.#state.busy)
      throw new Error("An operation is already running on this host");
    this.#state.busy = true;
    this.#operation = "restore";
    this.#pending = (async () => {
      let result,
        confirmed = false;
      try {
        const args = [
          "restore",
          "--json",
          "--repo",
          entry.commonDir,
          "--head",
          entry.head,
        ];
        args.push(
          entry.detached ? "--detach" : "--branch",
          entry.detached ? entry.head : entry.branch,
        );
        if (entry.host) args.push("--host", entry.host);
        args.push("--", entry.path);
        result = JSON.parse(await this.#run(args));
        if (
          result?.path !== entry.path ||
          result.restored !== true ||
          result.branch !== (entry.detached ? "" : entry.branch) ||
          typeof result.head !== "string" ||
          !/^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/.test(result.head)
        )
          throw new Error(result?.error || "Arbor did not confirm restore");
        confirmed = true;
        try {
          await this.#deletions.remove(entry.id);
        } catch (error) {
          result.warning = `Put back, but could not save history: ${error.message}`;
        }
        try {
          await this.#refreshTarget(entry, true);
        } catch (error) {
          result.warning = `Put back, but could not inspect it: ${error.message}`;
        }
      } catch (error) {
        if (!confirmed)
          result = {
            restored: false,
            error: restoreFailure(error, entry.path),
          };
        else
          result.warning = `Put back, but could not update history: ${error.message}`;
      } finally {
        if (this.#state.report)
          this.#cache.put(this.#options, this.#state.report);
        await this.#cache.pending;
        this.#state.busy = false;
        this.#operation = null;
        this.#state.revision = randomUUID();
      }
      return {
        ...result,
        id: entry.id,
        path: entry.path,
        host: entry.host,
        clean: entry.clean,
      };
    })();
    return this.#pending;
  }

  async #inspectAfterCleanup(row) {
    try {
      if (this.#stopAfterCurrent || this.#disposed)
        throw new Error("Inspection skipped while closing");
      await this.#refreshTarget(row);
    } catch (error) {
      this.#markInspectionFailure(row, error);
      return error.message;
    }
  }

  async remove(value, confirm) {
    this.assertInteractive();
    if (this.#state.busy) throw new Error("An operation is already running");
    const plan = planRemoval(this.#state, value);
    this.#state.busy = true;
    this.#state.error = "";
    this.#operation = "remove";
    this.#stopAfterCurrent = false;
    this.#stopRequested = false;
    this.#beginProgress("removing");
    this.#state.progress.total = plan.selected.length;
    const options = { ...this.#options };
    this.#pending = executeCleanupBatch(plan, {
      host: options.host,
      run: this.#run,
      confirm,
      shouldStop: () => this.#stopAfterCurrent || this.#stopRequested,
      onBegin: () => {
        this.#state.revision = null;
      },
      onProgress: (progress) => Object.assign(this.#state.progress, progress),
      reconcile: (row, outcome) => this.#reconcileRemoval(row, outcome),
    })
      .then((result) => {
        if (!result.cancelled) this.#state.revision = randomUUID();
        return {
          ...result,
          report: structuredClone(this.#state.report),
          revision: this.#state.revision,
          ...(!result.cancelled ? { error: this.#state.error } : {}),
        };
      })
      .finally(async () => {
        this.#cache.put(options, this.#state.report);
        await this.#cache.pending;
        this.#state.busy = false;
        this.#operation = null;
        this.#stopRequested = false;
        this.#state.progress = null;
        this.#live.clear();
      });
    return this.#pending;
  }

  // The worktree being deleted is finished, since half of one is worse
  // than either; the ones after it are left as they are.
  stopRemoval() {
    if (this.#operation !== "remove") throw new Error("No cleanup is running");
    this.#stopRequested = true;
  }

  #stopCleanupAfterCurrent() {
    if (this.#operation !== "remove") throw new Error("No cleanup is running");
    this.#stopAfterCurrent = true;
    this.#targetInspectionController?.abort();
  }
}

module.exports = { Backend };
