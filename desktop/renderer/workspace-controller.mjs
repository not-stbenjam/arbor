import { size } from "./presentation.mjs";

// Relative times such as "5m ago" go stale without any change in state.
const REDRAW_INTERVAL = 30000;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const immutableCopy = (value) => deepFreeze(structuredClone(value));

// Owns backend snapshots and operation generations. Views consume snapshots and
// issue commands; no renderer controller may mutate scan/cleanup lifecycle state.
export function createWorkspaceController({
  api,
  linked,
  notify,
  onChange,
  onSetup,
  onHostChange,
  onReset,
  onScanAccepted = () => {},
  timers = globalThis,
}) {
  const state = {
    report: null,
    busy: false,
    error: "",
    warning: "",
    root: "",
    host: "",
    hostFilter: null,
    hosts: [],
    revision: "",
    version: "",
    platform: "linux",
    setupRequired: false,
    options: null,
    progress: null,
    cancelled: false,
    cancelRequested: false,
  };

  let connected = false,
    removing = false,
    resettingPreferences = false;
  let clientError = "",
    dismissedError = "",
    dismissedWarning = "",
    pollTimer,
    pollGeneration = 0;
  const queuedPreferences = new Map();
  let preferencesGeneration = 0;
  let polled = "",
    publishedAt = 0;
  const setTimeout = (...args) => timers.setTimeout(...args),
    clearTimeout = (timer) => timers.clearTimeout(timer);
  // Clone only incoming data; publication then shares those frozen subtrees.
  // Getters return a cached immutable view, never a live controller-owned object.
  for (const value of Object.values(state)) deepFreeze(value);
  let published = Object.freeze({ ...state });
  let publishedRows = [];
  let publishedItems = Object.freeze(linked(publishedRows));
  function publish() {
    published = Object.freeze({ ...state });
    const rows = published.report?.worktrees || [];
    if (rows !== publishedRows) {
      publishedRows = rows;
      publishedItems = Object.freeze(linked(rows));
    }
    publishedAt = Date.now();
    onChange();
  }
  const blocked = () =>
    !connected ||
    removing ||
    state.removing ||
    state.setupRequired ||
    resettingPreferences;
  const filter = () => state.hostFilter;
  const hasActivity = () =>
    state.busy || state.hosts.some((source) => source.busy);
  const canDelete = (row) => {
    if (blocked() || !state.revision || row.pending) return false;
    const source = state.hosts.find((entry) => entry.host === (row.host || ""));
    return !source || !["remove", "inspect"].includes(source.operation);
  };
  function showError(message) {
    clientError = message;
    dismissedError = "";
    publish();
  }
  // `snapshot` identifies a polled state so the next identical poll can be
  // skipped. A command's result is always published and clears it.
  function updateState(next, snapshot = "") {
    polled = snapshot;
    Object.assign(state, immutableCopy(next));
    connected = true;
    publish();
    if (state.setupRequired && !resettingPreferences) onSetup();
  }
  function reloadAcceptedPreferences(next) {
    const generation = preferencesGeneration;
    for (const [host, options] of queuedPreferences) {
      // queued stays true through persistence, not just scheduler waiting.
      // Missing hosts have been forgotten; reload their canonical removal too.
      if (next.hosts.find((source) => source.host === host)?.queued) continue;
      queuedPreferences.delete(host);
      Promise.resolve()
        .then(() => {
          if (generation === preferencesGeneration)
            return onScanAccepted(options);
        })
        .catch((error) => {
          if (generation === preferencesGeneration)
            notify(`Could not reload settings: ${error.message}`, true);
        });
    }
  }
  async function poll() {
    clearTimeout(pollTimer);
    const generation = pollGeneration;
    if (resettingPreferences) {
      pollTimer = setTimeout(poll, 1000);
      return;
    }
    try {
      const next = await api.getState();
      if (generation === pollGeneration && !resettingPreferences) {
        // An idle workspace answers every poll identically. Copying, freezing,
        // and redrawing it each time is the cost of a large list at rest.
        const snapshot = JSON.stringify(next);
        if (
          snapshot !== polled ||
          !connected ||
          Date.now() - publishedAt >= REDRAW_INTERVAL
        )
          updateState(next, snapshot);
        reloadAcceptedPreferences(next);
      }
    } catch (error) {
      if (generation !== pollGeneration || resettingPreferences) return;
      connected = false;
      polled = "";
      showError(error.message || "Could not connect to the Arbor backend.");
    } finally {
      // Whatever a poll or its rendering did, the next one is always scheduled.
      if (generation === pollGeneration && !resettingPreferences)
        pollTimer = setTimeout(poll, hasActivity() ? 700 : 3000);
    }
  }
  // Resolves once the backend has taken the scan up or refused it. A refusal
  // is returned as well as shown, for whoever asked to say so where the
  // request was made.
  async function scan(options) {
    if (blocked()) return {};
    options = structuredClone(options);
    clientError = "";
    dismissedError = "";
    dismissedWarning = "";
    const generation = ++pollGeneration;
    clearTimeout(pollTimer);
    const oldHost = filter();
    state.busy = true;
    publish();
    try {
      const next = await api.scan(options);
      if (generation !== pollGeneration) return {};
      if (next.hostFilter !== oldHost) onHostChange();
      updateState(next);
      const host = options.host || "";
      if (next.hosts.find((source) => source.host === host)?.queued)
        queuedPreferences.set(host, options);
      else {
        queuedPreferences.delete(host);
        await onScanAccepted(options);
      }
      if (generation !== pollGeneration) return {};
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 500);
      return {};
    } catch (error) {
      if (generation !== pollGeneration) return {};
      state.busy = false;
      showError(error.message);
      publish();
      pollTimer = setTimeout(poll, 700);
      return { error: error.message };
    }
  }
  async function hostCommand(method, host = filter()) {
    if (blocked()) return;
    const generation = ++pollGeneration;
    clearTimeout(pollTimer);
    clientError = "";
    dismissedError = "";
    dismissedWarning = "";
    const previous = filter();
    try {
      const next = await api[method](host);
      if (generation !== pollGeneration) return;
      if (method === "setHostFilter" && host !== previous) onHostChange();
      updateState(next);
    } catch (error) {
      if (generation === pollGeneration) showError(error.message);
    } finally {
      if (generation === pollGeneration) schedule(350);
    }
  }
  function refreshHosts(host = filter()) {
    return hostCommand("refreshHosts", host);
  }
  function setHostFilter(host) {
    return hostCommand("setHostFilter", host);
  }
  function refresh() {
    return refreshHosts();
  }
  async function remove(list, recommendedOnly, options = {}) {
    if (blocked() || !state.revision || !list.length) return;
    const revision = state.revision;
    removing = true;
    clientError = "";
    pollGeneration++;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 350);
    publish();
    try {
      const result = await api.remove({
        items: list.map((w) => ({ id: w.id, head: w.head })),
        recommendedOnly,
        revision,
        discardLocal: options.discardLocal === true,
        forceConfirm: options.forceConfirm === true,
      });
      if (Object.hasOwn(result, "report"))
        state.report = immutableCopy(result.report);
      if (Object.hasOwn(result, "revision")) state.revision = result.revision;
      if (result.error) showError(result.error);
      const removed = (result.results || []).filter((r) => r.removed),
        failed = (result.results || []).filter((r) => !r.removed);
      if (removed.length) {
        const key = (host, path) => JSON.stringify([host || "", path]);
        const gone = new Set(removed.map((r) => key(r.host, r.path)));
        // A missing checkout had no folder, whatever an older scan measured.
        const freed = list
          .filter((w) => !w.missing && gone.has(key(w.host, w.path)))
          .reduce((total, w) => total + Math.max(0, w.sizeBytes || 0), 0);
        // Sizes come from the last scan, so the figure is an estimate.
        const folders = list.filter(
          (w) => !w.missing && gone.has(key(w.host, w.path)),
        ).length;
        const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
        notify(
          folders
            ? `Deleted ${count(removed.length, "worktree")}${freed ? ` · About ${size(freed)} recovered` : ""}.`
            : `Removed ${count(removed.length, "missing worktree registration")}.`,
        );
      }
      if (failed.length)
        showError(
          failed
            .map(
              (r) =>
                `${typeof r.host === "string" ? `${r.host || "This computer"}:` : ""}${r.path}: ${r.error || "Not removed"}`,
            )
            .join("\n"),
        );
    } catch (error) {
      showError(error.message);
    } finally {
      // A progress poll may still contain busy=true. Settle from the backend
      // after remove resolves, and discard every poll from the old operation.
      pollGeneration++;
      clearTimeout(pollTimer);
      try {
        updateState(await api.getState());
      } catch (error) {
        connected = false;
        showError(`Could not refresh Arbor after deletion: ${error.message}`);
      }
      removing = false;
      publish();
      pollTimer = setTimeout(poll, hasActivity() ? 700 : 3000);
    }
  }
  function explainKept(kept, append = false) {
    if (!kept.length) return;
    const explanation = kept
      .map(
        (w) =>
          `${w.path}: ${(w.blockers || []).concat(w.problems || []).join("; ") || (w.pending ? "Scan again to finish checking this worktree." : "This directory cannot be deleted as a linked worktree.")}`,
      )
      .join("\n");
    showError(
      append && clientError ? `${clientError}\n${explanation}` : explanation,
    );
  }
  async function deleteWorktrees(selected) {
    if (blocked() || !state.revision || !selected.length) return;
    const kept = selected.filter(
      (w) => !canDelete(w) || (!w.canRemove && !w.canDiscard),
    );
    const eligible = selected.filter(
      (w) => canDelete(w) && (w.canRemove || w.canDiscard),
    );
    if (!eligible.length) {
      explainKept(kept);
      return;
    }
    await remove(eligible, false, {
      forceConfirm: true,
      discardLocal: eligible.some((w) => !w.canRemove && w.canDiscard),
    });
    explainKept(kept, true);
  }

  function schedule(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }
  async function completeSetup(options) {
    const generation = ++pollGeneration;
    clearTimeout(pollTimer);
    try {
      const next = await api.completeSetup(options);
      if (generation !== pollGeneration) return;
      updateState(next);
      await onScanAccepted(options);
      if (generation !== pollGeneration) return;
      schedule(350);
    } catch (error) {
      if (generation === pollGeneration) schedule(700);
      throw error;
    }
  }
  async function cancel(host = filter()) {
    const sources = state.hosts.filter(
      (entry) => host === null || entry.host === host,
    );
    if (!sources.some((entry) => entry.canCancelScan && !entry.cancelRequested))
      return;
    const generation = ++pollGeneration;
    clearTimeout(pollTimer);
    try {
      const next = await api.cancelScan(host);
      if (generation !== pollGeneration) return;
      updateState(next);
      schedule(350);
    } catch (error) {
      if (generation !== pollGeneration) return;
      showError(error.message);
      schedule(700);
    }
  }
  async function reset() {
    if (resettingPreferences || removing) return;
    resettingPreferences = true;
    pollGeneration++;
    clearTimeout(pollTimer);
    publish();
    try {
      const result = await api.resetPreferences();
      if (result.cancelled) return;
      preferencesGeneration++;
      queuedPreferences.clear();
      clientError = "";
      dismissedError = "";
      onReset(result);
      resettingPreferences = false;
      updateState(result.state);
    } catch (error) {
      notify(`Could not reset settings: ${error.message}`, true);
    } finally {
      resettingPreferences = false;
      publish();
      schedule(700);
    }
  }
  async function initialize() {
    try {
      if (!api)
        throw new Error(
          "Open Arbor as a desktop app to connect to your workspace.",
        );
      const initial = await api.getState();
      updateState(initial);
      schedule(hasActivity() ? 500 : 2000);
    } catch (error) {
      showError(error.message);
    }
  }
  return {
    initialize,
    scan,
    refresh,
    refreshHosts,
    setHostFilter,
    canDelete,
    remove,
    deleteWorktrees,
    cancel,
    reset,
    showError,
    completeSetup,
    get snapshot() {
      return published;
    },
    get items() {
      return publishedItems;
    },
    get blocked() {
      return blocked();
    },
    get connected() {
      return connected;
    },
    get removing() {
      return removing || !!state.removing;
    },
    get resetting() {
      return resettingPreferences;
    },
    get error() {
      const message = clientError || state.error || "";
      return message === dismissedError ? "" : message;
    },
    get warning() {
      return state.warning === dismissedWarning ? "" : state.warning;
    },
    dismissError() {
      const error = clientError || state.error;
      if (error && error !== dismissedError) dismissedError = error;
      else dismissedWarning = state.warning;
      publish();
    },
    dispose() {
      pollGeneration++;
      preferencesGeneration++;
      queuedPreferences.clear();
      clearTimeout(pollTimer);
    },
  };
}
