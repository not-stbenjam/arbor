"use strict";

const { Backend } = require("./backend.cjs");
const { WorkspaceCache } = require("./workspace-cache.cjs");
const {
  scanOptions,
  validatePreferences,
  MAX_WORKTREES,
} = require("./protocol.cjs");
const { aggregateStats } = require("./aggregate-stats.cjs");
const { planRemoval } = require("./removal-policy.cjs");
const { HostScheduler } = require("./host-scheduler.cjs");
const { menuTarget } = require("./worktree-menu.cjs");
const {
  parseGlobalID,
  SnapshotRevisions,
  displayedRows,
  workspaceSnapshot,
} = require("./workspace-snapshot.cjs");

// Owns workspace routing, not Git operations. Each host's Backend independently
// owns scan/inspection/removal lifetime and its native revision. Aggregate
// revisions retain their per-host meaning when an unrelated host changes.
class WorkspaceCoordinator {
  #factory;
  #configuration;
  #cache;
  #entries = new Map();
  #filter = null;
  #revisions = new SnapshotRevisions();
  #scheduler;
  #setupRequired;
  #started = false;
  #closed = false;
  #transition = null;
  #transitionPending = Promise.resolve();
  #transitionController;
  #removing = false;
  #removalStopped = false;
  #cleanupHosts = new Set();
  #cleanupPending = Promise.resolve();
  #initialHost;
  #startedHosts = new Set();
  #lifecycleGeneration = 0;
  #configuring = new Set();
  #sessionHost;
  constructor({
    backendFactory = (options) => new Backend(options),
    concurrency = 3,
    cache = new WorkspaceCache(),
    hostFilter = null,
    sessionHost,
    ...configuration
  } = {}) {
    this.#factory = backendFactory;
    this.#cache = cache;
    this.#configuration = configuration;
    this.#setupRequired = configuration.setupRequired === true;
    this.#scheduler = new HostScheduler(concurrency);
    const options = scanOptions(
      configuration.options || {
        root: configuration.root,
        host: configuration.host,
      },
    );
    this.#initialHost = options.host;
    this.#sessionHost = sessionHost
      ? scanOptions({ host: sessionHost }).host
      : null;
    if (this.#sessionHost && this.#sessionHost !== options.host)
      throw new Error("Session host must match the explicit launch host");
    if (options.host) this.#entry("", scanOptions(), "This computer");
    this.#entry(options.host, options, options.host || "This computer");
    if (hostFilter !== null) this.#requireHost(hostFilter);
    this.#filter = hostFilter;
  }
  #entry(host, options, label) {
    let entry = this.#entries.get(host);
    if (!entry) {
      entry = {
        host,
        label,
        options,
        backend: this.#factory({
          ...this.#configuration,
          cache: this.#cache,
          options,
          setupRequired: false,
        }),
        error: "",
      };
      this.#entries.set(host, entry);
    }
    return entry;
  }
  #requireHost(host) {
    const entry = this.#entries.get(host);
    if (!entry) throw new Error("This host is no longer configured");
    return entry;
  }
  #selected(host = this.#filter) {
    return host === null
      ? [...this.#entries.values()]
      : [this.#requireHost(host)];
  }
  assertInteractive() {
    if (this.#closed) throw new Error("Arbor is closing");
    if (this.#transition) throw new Error("An operation is already running");
  }
  getState() {
    const hosts = [...this.#entries.values()].map((entry) => {
      const state = entry.backend.getState();
      const queued =
        this.#scheduler.queued(entry.host) ||
        (!!entry.requestedOptions && !state.busy);
      return {
        ...state,
        options: structuredClone(entry.requestedOptions || state.options),
        host: entry.host,
        label: entry.label,
        sessionOnly: entry.host === this.#sessionHost,
        queued,
        busy: state.busy || queued,
        canCancelScan:
          (queued && !state.cancelRequested) || state.canCancelScan,
        error: entry.error || state.error,
        progress: queued
          ? {
              stage: "queued",
              path: (entry.requestedOptions || entry.options).root,
              discovered: 0,
              completed: 0,
              total: 0,
              startedAt: entry.queuedAt,
            }
          : state.progress,
      };
    });
    return workspaceSnapshot(hosts, {
      hostFilter: this.#filter,
      revision: this.#revisions.capture(hosts),
      setupRequired: this.#setupRequired,
      removing: this.#removing,
    });
  }

  async synchronizeHosts(value) {
    this.assertInteractive();
    const preferences = validatePreferences(value);
    const wanted = new Map([
      [
        "",
        {
          host: "",
          name: "This computer",
          root: preferences.scan.host
            ? preferences.roots[0] || ""
            : preferences.scan.root,
        },
      ],
      ...preferences.hosts.map((host) => [host.host, host]),
    ]);
    if (this.#sessionHost && wanted.has(this.#sessionHost)) {
      // Once explicitly saved, this alias follows normal forgetting rules.
      this.#sessionHost = null;
    } else if (this.#sessionHost) {
      const session = this.#requireHost(this.#sessionHost);
      wanted.set(session.host, {
        host: session.host,
        name: session.label,
        root: session.options.root,
      });
    }
    for (const [host, entry] of this.#entries) {
      if (wanted.has(host)) continue;
      if (this.#cleanupHosts.has(host))
        throw new Error(
          "Wait for this host's cleanup to finish before removing it",
        );
      this.#scheduler.cancelQueued(host);
      entry.backend.requestClose();
      await entry.backend.waitUntilIdle();
      await this.#scheduler.waitForHost(host);
      this.#entries.delete(host);
      this.#startedHosts.delete(host);
    }
    for (const [host, saved] of wanted) {
      const existing = this.#entries.get(host);
      const canonical = preferences.scans.find(
        (options) => options.host === host,
      );
      const options =
        canonical ||
        scanOptions({ ...preferences.scan, host, root: saved.root });
      const entry = this.#entry(host, options, saved.name);
      entry.label = saved.name;
      // The initial explicit launch options take precedence until start.
      if (
        existing &&
        !this.#started &&
        (canonical || host !== this.#initialHost)
      )
        entry.options = options;
      if (!existing && this.#started && !this.#setupRequired)
        this.#schedule(entry, false);
    }
    if (this.#filter !== null && !this.#entries.has(this.#filter))
      this.#filter = null;
    return this.getState();
  }
  #schedule(entry, refresh) {
    entry.error = "";
    entry.queuedAt = Date.now();
    this.#startedHosts.add(entry.host);
    const promise = this.#scheduler.schedule(
      entry.host,
      () =>
        entry.backend.configureWorkspace(entry.options, async () => {}, {
          restore: !refresh,
        }),
      () => entry.backend.waitUntilIdle(),
      (error) => {
        entry.error = error.message;
      },
    );
    promise.catch(() => {});
    return promise;
  }
  async start({ refresh = false, host = null } = {}) {
    this.assertInteractive();
    this.#started = true;
    if (this.#setupRequired) return this.getState();
    // Restore every cached workspace before filling the background scan queue.
    const selected = this.#selected(host);
    for (const entry of selected) {
      this.#startedHosts.add(entry.host);
      if (this.#cache.get(entry.options))
        await entry.backend.configureWorkspace(entry.options, async () => {}, {
          restore: true,
        });
    }
    for (const entry of selected) {
      if (refresh || !entry.backend.getState().report)
        this.#schedule(entry, refresh);
    }
    return this.getState();
  }
  setHostFilter(host) {
    this.assertInteractive();
    if (host !== null) this.#requireHost(host);
    this.#filter = host;
    return this.getState();
  }
  refreshHosts(host = this.#filter) {
    this.assertInteractive();
    if (this.#setupRequired) throw new Error("Complete setup before scanning");
    for (const entry of this.#selected(host)) {
      if (
        !entry.backend.getState().busy &&
        !this.#cleanupHosts.has(entry.host) &&
        !this.#configuring.has(entry.host)
      )
        this.#schedule(entry, true);
    }
    return this.getState();
  }
  cancelScan(host = this.#filter) {
    this.assertInteractive();
    for (const entry of this.#selected(host)) {
      this.#scheduler.cancelQueued(entry.host);
      if (entry.backend.getState().canCancelScan) entry.backend.cancelScan();
    }
    return this.getState();
  }
  // Stops a deletion after the worktree it is on. One deletion can span
  // hosts, taken in turn, and stopping it leaves the later hosts alone too.
  stopRemoval() {
    if (this.#closed) throw new Error("Arbor is closing");
    if (!this.#removing) throw new Error("No cleanup is running");
    this.#removalStopped = true;
    for (const entry of this.#entries.values())
      if (entry.backend.getState().canStopRemoval) entry.backend.stopRemoval();
    return this.getState();
  }
  async configureWorkspace(value, persist, { restore = false } = {}) {
    this.assertInteractive();
    if (this.#setupRequired) throw new Error("Complete setup before scanning");
    const options = scanOptions(value);
    const entry = this.#entry(
      options.host,
      options,
      options.host || "This computer",
    );
    if (this.#cleanupHosts.has(options.host))
      throw new Error("Cleanup is running on this host");
    if (this.#configuring.has(options.host))
      throw new Error("An operation is already running on this host");
    this.#configuring.add(options.host);
    try {
      this.#filter = options.host;
      this.#scheduler.cancelQueued(options.host);
      if (entry.backend.getState().canCancelScan) entry.backend.cancelScan();
      await entry.backend.waitUntilIdle();
      await this.#scheduler.waitForHost(options.host);
      this.assertInteractive();
      if (this.#entries.get(options.host) !== entry)
        throw new Error("This host is no longer configured");
      this.#startedHosts.add(entry.host);
      entry.error = "";
      entry.queuedAt = Date.now();
      entry.requestedOptions = options;
      const accepted = this.#scheduler.schedule(
        options.host,
        () => entry.backend.configureWorkspace(options, persist, { restore }),
        () => entry.backend.waitUntilIdle(),
        (error) => {
          entry.error = error.message;
        },
      );
      accepted.then(
        (state) => {
          // A cancelled queued job resolves without being accepted. Its draft
          // must not replace the options used by later Refresh or reopen.
          if (state) entry.options = options;
          entry.requestedOptions = null;
          this.#configuring.delete(options.host);
        },
        () => {
          entry.requestedOptions = null;
          this.#configuring.delete(options.host);
        },
      );
      return this.getState();
    } catch (error) {
      this.#configuring.delete(options.host);
      throw error;
    }
  }
  async completeSetup(value, persist) {
    this.assertInteractive();
    const options = scanOptions(value);
    const entry = this.#entry(
      options.host,
      options,
      options.host || "This computer",
    );
    this.#transition = "setup";
    this.#transitionPending = (async () => {
      try {
        await persist(structuredClone(options));
        entry.options = options;
        this.#setupRequired = false;
        this.#filter = options.host;
        this.#started = true;
        this.#startedHosts.add(entry.host);
      } finally {
        this.#transition = null;
      }
      if (!this.#closed) this.#schedule(entry, true);
      return this.getState();
    })();
    return this.#transitionPending;
  }
  resolveWorktree(value) {
    const { host, id } = parseGlobalID(value?.id);
    const entry = this.#requireHost(host);
    const state = entry.backend.getState();
    if (this.#revisions.native(value.revision, host) !== state.revision)
      throw new Error("The worktree list changed; review it and try again");
    const rows = displayedRows({ ...state, host, label: entry.label }).map(
      (row) => ({ ...row, id: row.sourceID }),
    );
    const target = menuTarget(
      {
        ...state,
        host,
        report: { worktrees: rows },
        busy: this.#removing || (state.busy && state.operation !== "scan"),
      },
      { id, revision: state.revision },
    );
    return {
      ...target,
      id: value.id,
      revision: value.revision,
      retryInspection: target.retryInspection && !state.busy,
    };
  }
  inspectWorktree(value) {
    this.assertInteractive();
    const { host, id } = parseGlobalID(value?.id);
    if (this.#cleanupHosts.has(host))
      throw new Error("Cleanup is running on this host");
    this.resolveWorktree(value);
    const entry = this.#requireHost(host);
    entry.backend.inspectWorktree({
      id,
      revision: this.#revisions.native(value.revision, host),
    });
    return this.getState();
  }
  async remove(value, confirm) {
    this.assertInteractive();
    if (this.#removing) throw new Error("Cleanup is already running");
    if (!Array.isArray(value?.items) || !value.items.length)
      throw new Error("Choose at least one worktree");
    // Each host's share is bounded like its scan when it is planned below.
    // The combined view may select that much on every host at once.
    if (value.items.length > MAX_WORKTREES * this.#entries.size)
      throw new Error("Too many worktrees selected for one cleanup");
    const groups = new Map();
    for (const item of value.items) {
      const { host, id } = parseGlobalID(item.id);
      const entry = this.#requireHost(host);
      const revision = this.#revisions.native(value.revision, host);
      if (!groups.has(host))
        groups.set(host, {
          entry,
          selection: { ...value, revision, items: [] },
        });
      groups.get(host).selection.items.push({ id, head: item.head });
    }
    // Consent describes the selected snapshot. Background scans remain live
    // until approval; final native revisions are checked again before removal.
    for (const group of groups.values())
      group.plan = planRemoval(group.entry.backend.getState(), group.selection);
    this.#removing = true;
    this.#removalStopped = false;
    this.#cleanupHosts = new Set(groups.keys());
    this.#cleanupPending = (async () => {
      const results = [];
      try {
        const consent = [...groups.values()].flatMap(({ entry, plan }) =>
          plan.confirmation.map((row) => ({
            ...row,
            host: entry.host,
            hostLabel: entry.label,
          })),
        );
        if (
          consent.length &&
          (!confirm ||
            !(await confirm(consent, {
              discardLocal: value.discardLocal === true,
            })))
        )
          return { cancelled: true, results, ...this.#resultState() };
        if (this.#closed)
          return { cancelled: true, results, ...this.#resultState() };
        for (const { entry } of groups.values()) {
          this.#scheduler.cancelQueued(entry.host);
          if (entry.backend.getState().canCancelScan)
            entry.backend.cancelScan();
        }
        await Promise.all(
          [...groups.values()].map(async ({ entry }) => {
            await entry.backend.waitUntilIdle();
            await this.#scheduler.waitForHost(entry.host);
          }),
        );
        if (this.#closed)
          return { cancelled: true, results, ...this.#resultState() };
        for (const { entry, selection } of groups.values())
          planRemoval(entry.backend.getState(), selection);
        for (const { entry, selection, plan } of groups.values()) {
          if (this.#closed || this.#removalStopped) break;
          try {
            const outcome = await entry.backend.remove(
              selection,
              async () => true,
            );
            results.push(
              ...outcome.results.map((result) => ({
                ...result,
                host: entry.host,
              })),
            );
          } catch (error) {
            results.push(
              ...plan.selected.map((row) => ({
                host: entry.host,
                path: row.path,
                removed: false,
                error: String(error.message || error).slice(0, 4096),
              })),
            );
          }
        }
        return {
          results,
          stopped: this.#closed || this.#removalStopped,
          ...this.#resultState(),
        };
      } finally {
        this.#removing = false;
        this.#cleanupHosts.clear();
      }
    })();
    return this.#cleanupPending;
  }
  #resultState() {
    const { report, revision } = this.getState();
    return { report, revision };
  }
  async readStats(host = this.#filter) {
    this.assertInteractive();
    if (host !== null) return this.#requireHost(host).backend.readStats();
    const results = await Promise.all(
      this.#selected(null).map(async (entry) => {
        try {
          return { ...(await entry.backend.readStats()), label: entry.label };
        } catch (error) {
          return { host: entry.host, label: entry.label, error: error.message };
        }
      }),
    );
    return {
      host: null,
      report: aggregateStats(results),
    };
  }
  setGitHubAvailable(value) {
    for (const entry of this.#entries.values())
      entry.backend.setGitHubAvailable(value);
    this.#configuration.githubAvailable = value;
  }
  requestClose({ finishCleanup = false } = {}) {
    if (this.#removing && !finishCleanup) return { action: "confirm-cleanup" };
    this.#closed = true;
    this.#lifecycleGeneration++;
    this.#transitionController?.abort();
    this.#scheduler.cancelAllQueued();
    const actions = [...this.#entries.values()].map((entry) =>
      entry.backend.requestClose({ finishCleanup }),
    );
    return {
      action:
        this.#removing ||
        this.#transition ||
        actions.some((result) => result.action === "wait")
          ? "wait"
          : "close",
    };
  }
  async waitUntilIdle() {
    await Promise.all(
      [this.#transitionPending, this.#cleanupPending].map((promise) =>
        promise.catch(() => {}),
      ),
    );
    await this.#scheduler.waitUntilIdle();
    await Promise.all(
      [...this.#entries.values()].map((entry) => entry.backend.waitUntilIdle()),
    );
    return this.getState();
  }
  async reopen() {
    const generation = ++this.#lifecycleGeneration;
    await this.waitUntilIdle();
    if (generation !== this.#lifecycleGeneration) return this.getState();
    // Closing disposes every backend, including hosts that have never scanned.
    // Restore their interactivity without scanning them or occupying a slot.
    await Promise.all(
      [...this.#entries.values()]
        .filter((entry) => !this.#startedHosts.has(entry.host))
        .map((entry) =>
          entry.backend.reopen(entry.options, { activate: false }),
        ),
    );
    if (generation !== this.#lifecycleGeneration) return this.getState();
    this.#closed = false;
    for (const entry of this.#entries.values()) {
      if (!this.#startedHosts.has(entry.host)) continue;
      const promise = this.#scheduler.schedule(
        entry.host,
        () => entry.backend.reopen(entry.options),
        () => entry.backend.waitUntilIdle(),
        (error) => {
          entry.error = error.message;
        },
      );
      promise.catch(() => {});
    }
    return this.getState();
  }
  resetPreferences(confirm, persist) {
    this.assertInteractive();
    if (this.#removing)
      throw new Error("Wait for cleanup to finish before resetting Arbor");
    this.#transition = "reset";
    const controller = new AbortController();
    this.#transitionController = controller;
    this.#transitionPending = (async () => {
      try {
        if (!(await confirm(controller.signal)))
          return { cancelled: true, state: this.getState() };
        if (this.#closed) throw new Error("Arbor is closing");
        this.#scheduler.cancelAllQueued();
        for (const entry of this.#entries.values())
          if (entry.backend.getState().canCancelScan)
            entry.backend.cancelScan();
        await this.#scheduler.waitUntilIdle();
        await Promise.all(
          [...this.#entries.values()].map((entry) =>
            entry.backend.waitUntilIdle(),
          ),
        );
        if (this.#closed) throw new Error("Arbor is closing");
        await persist();
        for (const entry of this.#entries.values())
          entry.backend.requestClose();
        this.#entries.clear();
        this.#sessionHost = null;
        this.#startedHosts.clear();
        this.#cache.clear();
        await this.#cache.pending;
        this.#setupRequired = true;
        this.#filter = null;
        this.#revisions.clear();
        this.#entry("", scanOptions(), "This computer");
        return { cancelled: false, state: this.getState() };
      } finally {
        this.#transition = null;
        this.#transitionController = null;
      }
    })();
    return this.#transitionPending;
  }
}

module.exports = { WorkspaceCoordinator };
