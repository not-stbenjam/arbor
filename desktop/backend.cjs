"use strict";

const { randomUUID } = require("node:crypto");
const os = require("node:os");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const {
  planRemoval,
  removalArguments,
  removalFailure,
} = require("./removal-policy.cjs");
const { scanOptions, parseReport, progressEvent } = require("./protocol.cjs");
const { execute, childEnvironment } = require("./process-runner.cjs");
const MAX_PARTIAL_WORKTREES = 20000;

class Backend {
  #cache;
  #run;
  #partialPaths;
  #scanController;
  #targetInspectionController;
  #stopAfterCurrent;
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
    setupRequired = false,
    cache = new WorkspaceCache(),
  }) {
    this.#cache = cache;
    this.#operation = null;
    this.#partialPaths = new Map();
    this.#options = scanOptions(options || { root, host });
    this.#state = {
      report: null,
      busy: false,
      error: "",
      root: this.#options.root,
      host: this.#options.host,
      options: { ...this.#options },
      setupRequired,
      progress: null,
      partialWorktrees: [],
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
    return structuredClone(this.#state);
  }

  assertInteractive() {
    if (this.#disposed) throw new Error("Arbor is closing");
    if (this.#transition === "setup") throw new Error("Setup is being saved");
    if (this.#transition) throw new Error("An operation is already running");
  }

  async waitUntilIdle() {
    // Setup/reset can start or finish a scan while the caller is waiting.
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

  start({ refresh = false } = {}) {
    this.assertInteractive();
    if (this.#state.setupRequired) return this.getState();
    return refresh
      ? this.scan(this.#options)
      : this.activateWorkspace(this.#options);
  }

  configureWorkspace(value, persist, { restore = false } = {}) {
    this.assertInteractive();
    if (this.#state.setupRequired)
      throw new Error("Complete setup before scanning");
    if (this.#state.busy && (!restore || this.#operation !== "scan"))
      throw new Error("An operation is already running");
    const options = scanOptions(value);
    this.#transition = "workspace";
    this.#transitionPending = (async () => {
      try {
        if (this.#state.busy) {
          this.#cancelScan();
          await this.#pending;
        }
        if (this.#disposed) throw new Error("Arbor is closing");
        await persist(structuredClone(options));
        this.#options = options;
      } finally {
        this.#transition = null;
      }
      if (this.#disposed) return this.getState();
      return restore ? this.activateWorkspace(options) : this.scan(options);
    })();
    return this.#transitionPending;
  }

  completeSetup(value, persist) {
    this.assertInteractive();
    if (this.#state.busy) throw new Error("An operation is already running");
    const options = scanOptions(value);
    this.#transition = "setup";
    this.#transitionPending = (async () => {
      try {
        await persist(structuredClone(options));
        this.#options = options;
        this.#state.setupRequired = false;
      } finally {
        this.#transition = null;
      }
      // Saving preferences must not launch a new subprocess after close.
      return this.#disposed ? this.getState() : this.scan(options);
    })();
    return this.#transitionPending;
  }

  resetPreferences(confirm, persist) {
    this.assertInteractive();
    if (this.#operation === "remove")
      throw new Error("Wait for cleanup to finish before resetting Arbor");
    if (this.#state.busy && this.#operation !== "scan")
      throw new Error("Wait for inspection to finish before resetting Arbor");
    this.#transition = "reset";
    const controller = new AbortController();
    this.#transitionController = controller;
    this.#transitionPending = (async () => {
      try {
        if (!(await confirm(controller.signal)))
          return { cancelled: true, state: this.getState() };
        if (this.#disposed) throw new Error("Arbor is closing");
        if (this.#operation === "scan") {
          this.#cancelScan();
          await this.#pending;
        }
        if (this.#disposed) throw new Error("Arbor is closing");
        await persist();
        this.#resetState();
        await this.#cache.pending;
        return { cancelled: false, state: this.getState() };
      } finally {
        this.#transitionController = null;
        this.#transition = null;
      }
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
    if (this.#operation === "remove") this.stopCleanupAfterCurrent();
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

  async reopen() {
    const generation = ++this.#lifecycleGeneration;
    await this.waitUntilIdle();
    if (generation !== this.#lifecycleGeneration) return this.getState();
    this.#disposed = false;
    return this.start();
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
            if (worktree) {
              const index = this.#partialPaths.get(worktree.path);
              if (index !== undefined)
                this.#state.partialWorktrees[index] = worktree;
              else if (
                this.#state.partialWorktrees.length < MAX_PARTIAL_WORKTREES
              ) {
                this.#partialPaths.set(
                  worktree.path,
                  this.#state.partialWorktrees.length,
                );
                this.#state.partialWorktrees.push(worktree);
              }
            }
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
    this.#state.partialWorktrees = [];
    this.#partialPaths.clear();
    this.#state.progress = {
      stage,
      path: this.#options.root,
      discovered: 0,
      completed: 0,
      total: 0,
      startedAt: Date.now(),
    };
  }

  async activateWorkspace(value = {}) {
    this.assertInteractive();
    if (this.#state.setupRequired)
      throw new Error("Complete setup before scanning");
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
    if (!report) return this.scan(options);
    this.#options = options;
    this.#partialPaths.clear();
    Object.assign(this.#state, {
      report,
      root: report.root,
      host: options.host,
      options: { ...options },
      busy: false,
      error: "",
      revision: randomUUID(),
      cached: true,
      progress: null,
      partialWorktrees: [],
      cancelled: false,
      cancelRequested: false,
      canCancelScan: false,
    });
    return this.getState();
  }

  scan(value = {}) {
    this.assertInteractive();
    if (this.#state.setupRequired)
      throw new Error("Complete setup before scanning");
    if (this.#state.busy) throw new Error("An operation is already running");
    this.#options = scanOptions(value);
    Object.assign(this.#state, {
      report: null,
      busy: true,
      error: "",
      root: this.#options.root,
      host: this.#options.host,
      revision: null,
      options: { ...this.#options },
      cancelled: false,
      cancelRequested: false,
      canCancelScan: true,
      cached: false,
    });
    this.#beginProgress();
    this.#operation = "scan";
    this.#scanController = new AbortController();
    const options = { ...this.#options };
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
          this.#state.partialWorktrees = [];
          this.#partialPaths.clear();
        }
      });
    return this.getState();
  }

  cancelScan() {
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

  #resetState() {
    this.#options = scanOptions();
    this.#cache.clear();
    this.#partialPaths.clear();
    this.#scanController = null;
    Object.assign(this.#state, {
      report: null,
      busy: false,
      error: "",
      root: this.#options.root,
      host: this.#options.host,
      options: { ...this.#options },
      setupRequired: true,
      progress: null,
      partialWorktrees: [],
      cancelled: false,
      cancelRequested: false,
      canCancelScan: false,
      revision: null,
      cached: false,
    });
    return this.getState();
  }

  async #refreshTarget(row) {
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
      const current = report.worktrees.find((entry) => entry.id === row.id);
      const index = this.#state.report.worktrees.findIndex(
        (entry) => entry.id === row.id,
      );
      if (index < 0) return;
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
      `Inspection failed: ${error.message}. Use Retry Inspection from the context menu.`,
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

  async remove(value, confirm) {
    this.assertInteractive();
    if (this.#state.busy) throw new Error("An operation is already running");
    const { selected, discardLocal, recommendedOnly, confirmation } =
      planRemoval(this.#state, value);
    this.#state.busy = true;
    this.#state.error = "";
    this.#operation = "remove";
    this.#stopAfterCurrent = false;
    this.#beginProgress("removing");
    this.#state.progress.total = selected.length;
    const options = { ...this.#options },
      results = [],
      statsSession = randomUUID();
    const perform = async () => {
      try {
        if (
          confirmation.length &&
          (!confirm || !(await confirm(confirmation, { discardLocal })))
        )
          return {
            cancelled: true,
            results,
            report: structuredClone(this.#state.report),
            revision: this.#state.revision,
          };
        this.#state.revision = null;
        for (const w of selected) {
          if (this.#stopAfterCurrent) break;
          this.#state.progress.path = w.path;
          const args = removalArguments(w, {
            host: options.host,
            statsSession,
            discardLocal,
            recommendedOnly,
          });
          try {
            const result = JSON.parse(await this.#run(args));
            if (!result || result.path !== w.path || result.removed !== true)
              throw new Error(result?.error || "Arbor did not confirm removal");
            results.push({
              path: w.path,
              removed: true,
              ...(typeof result.retainedBranch === "string" &&
              result.retainedBranch
                ? { retainedBranch: result.retainedBranch }
                : {}),
            });
            this.#state.report.worktrees = this.#state.report.worktrees.filter(
              (entry) => entry.id !== w.id,
            );
            this.#cache.removePaths(options.host, [w.path]);
            for (const sibling of this.#state.report.worktrees.filter(
              (entry) => entry.path === w.path,
            )) {
              try {
                if (this.#stopAfterCurrent || this.#disposed)
                  throw new Error("Inspection skipped while closing");
                await this.#refreshTarget(sibling);
              } catch (error) {
                this.#markInspectionFailure(sibling, error);
              }
            }
          } catch (error) {
            const message = removalFailure(error, w.path);
            const outcome = {
              path: w.path,
              removed: false,
              error: message,
            };
            results.push(outcome);
            const entry = this.#state.report.worktrees.find(
              (item) => item.id === w.id,
            );
            if (entry) {
              entry.lastRemovalError = message;
              try {
                if (this.#stopAfterCurrent)
                  throw new Error("Inspection skipped while closing");
                await this.#refreshTarget(entry);
              } catch (inspectionError) {
                this.#markInspectionFailure(entry, inspectionError);
                outcome.inspectionError = inspectionError.message;
              }
            }
          }
          this.#state.progress.completed = results.length;
        }
        // Successful removals are already verified by the CLI. Preserve the
        // untouched snapshot rather than starting another whole-disk scan.
        this.#state.revision = randomUUID();
        return {
          results,
          stopped: this.#stopAfterCurrent,
          report: structuredClone(this.#state.report),
          revision: this.#state.revision,
          error: this.#state.error,
        };
      } finally {
        this.#cache.put(options, this.#state.report);
        await this.#cache.pending;
        this.#state.busy = false;
        this.#operation = null;
        this.#state.progress = null;
        this.#state.partialWorktrees = [];
        this.#partialPaths.clear();
      }
    };
    this.#pending = perform();
    return this.#pending;
  }

  stopCleanupAfterCurrent() {
    if (this.#operation !== "remove") throw new Error("No cleanup is running");
    this.#stopAfterCurrent = true;
    this.#targetInspectionController?.abort();
  }
}

module.exports = { Backend };
