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
    root: "",
    host: "",
    revision: "",
    version: "",
    platform: "linux",
    setupRequired: false,
    options: null,
    progress: null,
    partialWorktrees: [],
    cancelled: false,
    cancelRequested: false,
  };

  let connected = false,
    removing = false,
    resettingPreferences = false;
  let clientError = "",
    dismissedError = "",
    pollTimer,
    pollGeneration = 0;
  const setTimeout = (...args) => timers.setTimeout(...args),
    clearTimeout = (timer) => timers.clearTimeout(timer);
  // Clone only incoming data; publication then shares those frozen subtrees.
  // Getters return a cached immutable view, never a live controller-owned object.
  for (const value of Object.values(state)) deepFreeze(value);
  let published = Object.freeze({ ...state });
  let publishedRows = published.partialWorktrees;
  let publishedItems = Object.freeze(linked(publishedRows));
  function publish() {
    published = Object.freeze({ ...state });
    const rows =
      published.report?.worktrees || published.partialWorktrees || [];
    if (rows !== publishedRows) {
      publishedRows = rows;
      publishedItems = Object.freeze(linked(rows));
    }
    onChange();
  }
  const blocked = () =>
    !connected ||
    state.busy ||
    removing ||
    state.setupRequired ||
    resettingPreferences;
  function showError(message) {
    clientError = message;
    dismissedError = "";
    publish();
  }
  function updateState(next) {
    Object.assign(state, immutableCopy(next));
    connected = true;
    publish();
    if (state.setupRequired && !resettingPreferences) onSetup();
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
      if (generation === pollGeneration && !resettingPreferences)
        updateState(next);
    } catch (error) {
      if (generation !== pollGeneration || resettingPreferences) return;
      connected = false;
      showError(error.message || "Could not connect to the Arbor backend.");
      publish();
    }
    if (generation !== pollGeneration) return;
    pollTimer = setTimeout(poll, state.busy ? 700 : 3000);
  }
  async function scan(options, activate = false) {
    if (
      activate
        ? !connected || removing || state.setupRequired || resettingPreferences
        : blocked()
    )
      return;
    options = structuredClone(options);
    clientError = "";
    dismissedError = "";
    const generation = ++pollGeneration;
    clearTimeout(pollTimer);
    const oldHost = state.host;
    state.busy = true;
    publish();
    try {
      const next = await (activate
        ? api.activateWorkspace(options)
        : api.scan(options));
      if (generation !== pollGeneration) return;
      if ((options.host || "") !== oldHost) onHostChange();
      updateState(next);
      await onScanAccepted(options);
      if (generation !== pollGeneration) return;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 500);
    } catch (error) {
      if (generation !== pollGeneration) return;
      state.busy = false;
      showError(error.message);
      publish();
      pollTimer = setTimeout(poll, 700);
    }
  }
  function refresh() {
    return scan({
      ...(state.options || {}),
      root: state.root,
      host: state.host,
    });
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
        notify(
          `Deleted ${removed.length} ${removed.length === 1 ? "worktree folder" : "worktree folders"}.`,
        );
      }
      if (failed.length)
        showError(
          failed
            .map((r) => `${r.path}: ${r.error || "Not removed"}`)
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
      pollTimer = setTimeout(poll, state.busy ? 700 : 3000);
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
      (w) => w.pending || (!w.canRemove && !w.canDiscard),
    );
    const eligible = selected.filter(
      (w) => !w.pending && (w.canRemove || w.canDiscard),
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
  async function cancel() {
    if (!state.busy || !state.canCancelScan || state.cancelRequested) return;
    state.cancelRequested = true;
    publish();
    try {
      updateState(await api.cancelScan());
      schedule(350);
    } catch (error) {
      state.cancelRequested = false;
      showError(error.message);
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
      schedule(initial.busy ? 500 : 2000);
    } catch (error) {
      showError(error.message);
    }
  }
  return {
    initialize,
    scan,
    refresh,
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
      return removing;
    },
    get resetting() {
      return resettingPreferences;
    },
    get error() {
      const message = clientError || state.error || "";
      return message === dismissedError ? "" : message;
    },
    dismissError() {
      dismissedError = clientError || state.error;
      publish();
    },
    dispose() {
      pollGeneration++;
      clearTimeout(pollTimer);
    },
  };
}
