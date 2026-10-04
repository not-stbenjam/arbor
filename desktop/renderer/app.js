(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const paths = {
    branch:
      '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-3h6a6 6 0 0 0 6-6"/>',
    trees:
      '<path d="M8 21V3m0 5L4 5m4 9-5-4m5 8 5-4M16 3v7m0-4 4-3m-4 7 4-3"/>',
    merge:
      '<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M7 7v10m11-10c0 7-11 3-11 10"/>',
    monitor:
      '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    server:
      '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6"/>',
    chevrons: '<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-right": '<path d="m9 6 6 6-6 6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    settings:
      '<path d="m10 3-1 3-3 1-3 3 2 2-1 3 3 3 3-1 2 4 3-2 1-3 4-1 1-4-3-1-1-3-4-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
    sliders:
      '<path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    refresh:
      '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
    cleanup:
      '<path d="m14 3 7 7M4 20l3-8 6-6 5 5-6 6-8 3Zm3-8 5 5M2 7h4m-2-2v4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    sort: '<path d="m8 8 4-4 4 4m-8 8 4 4 4-4"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    folder:
      '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    warning: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
    external:
      '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
    moon: '<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chart: '<path d="M4 3v18h17M9 16v-4m5 4V8m5 8V5"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  };
  const icon = (name, extra = "") =>
    `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.branch}</svg>`;
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.outerHTML = icon(el.dataset.icon);
  });
  document
    .querySelectorAll("dialog")
    .forEach((dialog) =>
      dialog.setAttribute(
        "aria-label",
        dialog.querySelector("h2")?.textContent || "Arbor dialog",
      ),
    );
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
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
  const defaultExcludes = [
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
  let prefs = {
      hosts: [],
      roots: [],
      theme: "system",
      scan: {},
      setupCompleted: false,
    },
    view = "all",
    repo = "",
    search = "",
    sort = "path",
    descending = false;
  let selection = new Set(),
    anchor = "",
    cursor = "",
    connected = false,
    removing = false,
    clientError = "",
    dismissedError = "";
  let pollTimer,
    rowSignature = "",
    repoSignature = "",
    visible = [],
    desiredFetch = false,
    desiredGitHub = false,
    desiredExcludes = [...defaultExcludes],
    setupStep = 1,
    setupInitialized = false,
    setupSubmitting = false,
    resettingPreferences = false,
    pollGeneration = 0;
  const tree = window.ArborTree;
  const collapsedDirectories = new Set();
  let directoryRows = [];
  const items = () =>
    tree.linked(state.report?.worktrees || state.partialWorktrees || []);
  const blocked = () =>
    !connected ||
    state.busy ||
    removing ||
    state.setupRequired ||
    resettingPreferences;
  const machineName = () => state.host || "This computer";
  const branchName = (w) =>
    w.branch ||
    (w.pending
      ? (w.path || "Worktree").split("/").filter(Boolean).pop()
      : w.bare
        ? "Bare repository"
        : "Detached HEAD");
  const repoID = (w) => w.commonDir || w.repo || w.path;
  const parsedDate = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) || d.getFullYear() < 1971 ? null : d;
  };
  const ago = (value) => {
    const d = parsedDate(value);
    if (!d) return "Unknown";
    const s = Math.max(0, (Date.now() - d.valueOf()) / 1000);
    return s < 60
      ? "Just now"
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : s < 86400
          ? `${Math.floor(s / 3600)}h ago`
          : s < 86400 * 30
            ? `${Math.floor(s / 86400)}d ago`
            : s < 86400 * 365
              ? `${Math.floor(s / 2592000)}mo ago`
              : `${Math.floor(s / 31536000)}y ago`;
  };
  const fullDate = (value) =>
    parsedDate(value)?.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }) || "Unknown";
  const size = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let u = 0;
    while (bytes >= 1024 && u < 4) {
      bytes /= 1024;
      u++;
    }
    return `${bytes.toLocaleString(undefined, { maximumFractionDigits: u > 0 && bytes < 10 ? 1 : 0 })} ${units[u]}`;
  };
  const sizeOf = (list) =>
    list.reduce((n, w) => n + Math.max(0, w.sizeBytes || 0), 0);
  function notify(message, error = false) {
    const el = document.createElement("div");
    el.className = `toast${error ? " error" : ""}`;
    el.innerHTML = `${icon(error ? "warning" : "check-circle")}<span>${esc(message)}</span><button class="icon-button" aria-label="Dismiss notification">${icon("close")}</button>`;
    el.querySelector("button").onclick = () => el.remove();
    $("#toast-region").append(el);
    setTimeout(() => el.remove(), error ? 12000 : 5500);
  }
  function showError(message) {
    clientError = message;
    dismissedError = "";
    renderError();
  }
  function renderError() {
    const message = clientError || state.error || "";
    $("#error-banner").hidden = !message || message === dismissedError;
    $("#error-message").textContent = message;
  }
  function applyTheme() {
    document.documentElement.dataset.theme = prefs.theme;
    $("#theme-select").value = prefs.theme;
    $("#theme-button").innerHTML = icon(
      prefs.theme === "dark" ? "moon" : "sun",
    );
    $("#theme-button").title = `Appearance: ${prefs.theme}. Click to change.`;
  }
  async function savePrefs() {
    try {
      await window.arbor.savePreferences(prefs);
    } catch (error) {
      notify(`Could not save settings: ${error.message}`, true);
    }
  }
  function updateState(next) {
    const selectedPaths = new Set(
      items()
        .filter((w) => selection.has(w.id))
        .map((w) => w.path),
    );
    const cursorPath = items().find((w) => w.id === cursor)?.path;
    const anchorPath = items().find((w) => w.id === anchor)?.path;
    Object.assign(state, next);
    if (state.options) {
      desiredGitHub = !!state.options.github;
      desiredFetch = !!state.options.fetch;
      if (Array.isArray(state.options.excludes))
        desiredExcludes = [...state.options.excludes];
    }
    connected = true;
    document.body.classList.toggle(
      "platform-darwin",
      state.platform === "darwin",
    );
    document.body.classList.toggle(
      "platform-linux",
      state.platform !== "darwin",
    );
    $("#search-shortcut").textContent =
      state.platform === "darwin" ? "⌘F" : "Ctrl F";
    $("#settings-shortcut").textContent =
      state.platform === "darwin" ? "⌘," : "Ctrl ,";
    const existing = new Set(items().map((w) => w.id));
    selection = new Set([...selection].filter((id) => existing.has(id)));
    items().forEach((w) => {
      if (selectedPaths.has(w.path)) selection.add(w.id);
    });
    if (cursorPath)
      cursor = items().find((w) => w.path === cursorPath)?.id || cursor;
    if (anchorPath)
      anchor = items().find((w) => w.path === anchorPath)?.id || anchor;
    render();
    if (state.setupRequired && !resettingPreferences) openSetup();
  }
  async function poll() {
    clearTimeout(pollTimer);
    const generation = pollGeneration;
    if (resettingPreferences) {
      pollTimer = setTimeout(poll, 1000);
      return;
    }
    try {
      const next = await window.arbor.getState();
      if (generation === pollGeneration && !resettingPreferences)
        updateState(next);
    } catch (error) {
      if (generation !== pollGeneration || resettingPreferences) return;
      connected = false;
      showError(error.message || "Could not connect to the Arbor backend.");
      renderControls();
    }
    if (generation !== pollGeneration) return;
    pollTimer = setTimeout(poll, state.busy ? 700 : 3000);
  }
  function renderControls() {
    const disabled = blocked(),
      ready = items().filter((w) => w.recommended);
    for (const id of [
      "refresh-button",
      "machine-button",
      "path-button",
      "settings-save",
    ])
      $(`#${id}`).disabled = disabled;
    $("#scan-options-button").disabled = state.setupRequired;
    $("#reset-preferences").disabled =
      !connected ||
      resettingPreferences ||
      removing ||
      (state.busy && !state.canCancelScan && !state.cancelRequested);
    $("#reset-preferences").textContent = resettingPreferences
      ? "Resetting…"
      : "Reset to defaults…";
    $("#settings-save").textContent = removing
      ? "Cleanup in progress…"
      : state.busy
        ? "Scanning…"
        : "Save & scan";
    $('#host-form button[type="submit"]').disabled = disabled;
    $("#refresh-button").innerHTML =
      `${icon("refresh", state.busy ? "spinning" : "")}<span>${state.busy ? "Scanning" : state.cancelled ? "Scan again" : "Refresh"}</span>`;
    $("#cleanup-button").disabled =
      disabled || !state.revision || !ready.length;
    $("#cleanup-button").innerHTML =
      `${icon(removing ? "refresh" : "cleanup", removing ? "spinning" : "")}<span>${removing ? "Deleting…" : `Delete merged${ready.length ? ` (${ready.length})` : ""}`}</span>`;
    $("#cleanup-button").title =
      `Remove ${ready.length} recommended worktrees on ${machineName()} and reclaim ${size(sizeOf(ready))}. Branches are kept.`;
    document
      .querySelectorAll("[data-delete], [data-folder-delete]")
      .forEach((b) => {
        b.disabled = disabled || !state.revision;
      });
    $("#selection-bar").hidden = selection.size < 2;
    $("#selection-label").textContent = `${selection.size} worktrees selected`;
    $("#remove-selected").disabled =
      disabled || !selection.size || !state.revision;
  }
  function render() {
    const list = items(),
      ready = list.filter((w) => w.recommended),
      repositories = new Map();
    for (const w of list) {
      const key = repoID(w);
      if (!repositories.has(key))
        repositories.set(key, {
          id: key,
          name: w.repo || "Discovering…",
          count: 0,
        });
      repositories.get(key).count++;
    }
    const repos = [...repositories.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    $("#all-count").textContent = list.length;
    $("#recommended-count").textContent = ready.length;
    $("#repo-count").textContent = repos.length;
    $("#machine-label").textContent = machineName();
    $("#machine-label").title = machineName();
    $("#window-context").textContent = state.host
      ? `${state.host} — Arbor`
      : "Arbor";
    $("#connection-label").textContent = state.host
      ? "SSH workspace"
      : "Local workspace";
    $("#version").textContent = state.version || "";
    const path = `${state.host ? `${state.host}:` : ""}${state.root || "Home folder"}`;
    $("#root-label").textContent = path;
    $("#path-button").title = `Scan folder: ${path}`;
    const signature = JSON.stringify([repos, repo]);
    if (signature !== repoSignature) {
      $("#repo-list").innerHTML = repos.length
        ? repos
            .map(
              (r) =>
                `<button class="repo-item${r.id === repo ? " active" : ""}" data-repo="${esc(r.id)}" title="${esc(r.id)}">${icon("folder")}<span>${esc(r.name)}</span><span class="count">${r.count}</span></button>`,
            )
            .join("")
        : '<p class="repo-empty">No repositories found.</p>';
      repoSignature = signature;
    }
    document.querySelectorAll("[data-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === view && !repo);
      b.setAttribute(
        "aria-current",
        b.dataset.view === view && !repo ? "page" : "false",
      );
    });
    const title = repo
      ? repositories.get(repo)?.name || "Repository"
      : {
          all: "All worktrees",
          recommended: "Recommended",
        }[view];
    $("#view-title").textContent = title;
    $("#recommendation-note").hidden = view !== "recommended";
    $("#status-message").textContent = state.setupRequired
      ? "Choose a workspace to get started"
      : removing
        ? "Removing worktrees…"
        : state.busy
          ? state.host
            ? `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} found · scanning remote workspace…`
            : `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} found · scanning…`
          : state.cancelled
            ? `Scan stopped · ${list.length} ${list.length === 1 ? "worktree" : "worktrees"} found · scan again to finish checks`
            : `${list.length} ${list.length === 1 ? "worktree" : "worktrees"} · ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`;
    const warnings = state.report?.warnings || [];
    $("#warning-button").hidden = !warnings.length;
    $("#warning-button").textContent =
      `${warnings.length} ${warnings.length === 1 ? "note" : "notes"}`;
    $("#space-label").textContent = state.report
      ? `${size(sizeOf(list))} on disk`
      : "";
    $("#scan-time").textContent = state.report
      ? `${state.cached ? "Saved scan" : "Scanned"} ${ago(state.report.scannedAt).toLowerCase()}`
      : "";
    $("#scan-time").title = state.report
      ? `${fullDate(state.report.scannedAt)} · ${state.report.durationMs} ms`
      : "";
    renderError();
    renderProgress();
    renderRows();
    renderControls();
  }
  function renderRows() {
    const query = search.trim().toLowerCase();
    const filtered = tree.filter(items(), { repo, view, query });
    const directoryTree = tree.build(
      filtered,
      state.report?.root || state.root,
    );
    const value = (descendants) =>
      sort === "size"
        ? sizeOf(descendants)
        : sort === "activity"
          ? Math.max(
              ...descendants.map(
                (w) => parsedDate(w.activityAt)?.valueOf() || 0,
              ),
            )
          : sort === "branch"
            ? branchName(descendants[0])
            : sort === "repo"
              ? descendants[0].repo || ""
              : descendants[0].path;
    const compare = (a, b) => {
      if (sort === "path") return 0;
      const left = value(a),
        right = value(b);
      return (
        (typeof left === "number" ? left - right : left.localeCompare(right)) *
        (descending ? -1 : 1)
      );
    };
    directoryRows = tree.flatten(
      directoryTree,
      collapsedDirectories,
      sort === "path" && !descending ? undefined : compare,
    );
    if (sort === "path" && descending && directoryTree) {
      const reverse = (node) => {
        node.children.reverse();
        node.children.forEach(reverse);
      };
      reverse(directoryTree);
      directoryRows = tree.flatten(directoryTree, collapsedDirectories);
    }
    visible = directoryRows
      .filter((entry) => entry.kind === "worktree")
      .map((entry) => entry.worktree);
    $("#visible-count").textContent = filtered.length;
    $("#tree-sort").value = sort;
    document.querySelectorAll("[data-sort]").forEach((button) => {
      button.parentElement.classList.toggle(
        "sorted",
        button.dataset.sort === sort,
      );
      button.parentElement.setAttribute(
        "aria-sort",
        button.dataset.sort === sort
          ? descending
            ? "descending"
            : "ascending"
          : "none",
      );
    });
    const signature = JSON.stringify([
      filtered,
      sort,
      descending,
      view,
      search,
      repo,
      [...collapsedDirectories],
      state.busy,
      connected,
      removing,
      state.cancelled,
      state.revision,
      filtered.map((w) => ago(w.activityAt)),
    ]);
    if (signature === rowSignature) {
      renderSelection();
      return;
    }
    rowSignature = signature;
    $("#empty-state").hidden = filtered.length > 0;
    if (!filtered.length) {
      const loading = state.busy || (!connected && !clientError);
      const heading = loading
        ? "Finding linked worktrees…"
        : !items().length
          ? "No linked worktrees found"
          : "No matching worktrees";
      const description = loading
        ? "Worktree folders appear here as they are discovered."
        : !items().length
          ? "Choose a folder containing linked Git worktrees. Ordinary repository checkouts are not included."
          : "Try another search or repository.";
      $("#empty-state").innerHTML =
        `${icon(loading ? "refresh" : "folder", loading ? "spinning" : "")}<h2>${heading}</h2><p>${description}</p>${!loading && !items().length ? '<button class="button" data-open-settings>Choose scan folder</button>' : ""}`;
    }
    const indentation = (depth) =>
      '<span class="tree-indent" aria-hidden="true"></span>'.repeat(
        Math.min(depth, 12),
      );
    const scroll = $("#table-scroll").scrollTop;
    $("#worktree-list").innerHTML = directoryRows
      .map((entry) => {
        if (entry.kind === "directory") {
          const node = entry.node;
          const expanded = !collapsedDirectories.has(node.path);
          const count = `${node.descendants.length} ${node.descendants.length === 1 ? "worktree" : "worktrees"}`;
          return `<tr class="directory-row" data-directory-path="${esc(node.path)}" aria-level="${entry.depth + 1}" aria-expanded="${expanded}"><td colspan="3" class="directory-cell"><div class="directory-line">${indentation(entry.depth)}<button class="directory-toggle" data-toggle-directory="${esc(node.path)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(node.path)}">${icon(expanded ? "chevron-down" : "chevron-right")}${icon("folder")}<span title="${esc(node.path)}">${esc(entry.label)}</span></button><span class="directory-count">${count}</span></div></td><td class="action-cell"><button class="row-action folder-delete" data-folder-delete="${esc(node.path)}" title="Delete matching worktrees in this group; keep this folder" ${blocked() || !state.revision ? "disabled" : ""}>Delete…</button></td></tr>`;
        }
        const w = entry.worktree;
        const leaf = entry.label.split("/").pop();
        const prefix = entry.label.slice(0, -leaf.length);
        const pathLabel = `${prefix ? `<span class="path-chain">${esc(prefix)}</span>` : ""}<span class="path-basename">${esc(leaf)}</span>`;
        const context = w.pending
          ? state.cancelled
            ? "Scan incomplete"
            : "Checking…"
          : `${w.missing ? "Missing checkout · " : w.empty ? "Empty checkout · " : ""}${branchName(w)}${w.repo ? ` · ${w.repo}` : ""}`;
        return `<tr class="worktree-row${selection.has(w.id) ? " selected" : ""}${w.pending ? " pending-row" : ""}" data-id="${esc(w.id)}" data-path="${esc(w.path)}" aria-level="${entry.depth + 1}" aria-selected="${selection.has(w.id)}"><td class="branch-cell"><div class="tree-worktree-line">${indentation(entry.depth)}${icon("branch")}<div class="branch-copy"><span class="worktree-path" title="${esc(w.path)}" aria-label="${esc(w.path)}"><span class="path-parent">${esc(entry.pathPrefix.replace(/\/$/, "") + "/")}</span><span class="path-leaf">${pathLabel}</span></span><span class="worktree-context" title="${esc(context)}">${esc(context)}</span></div></div></td><td class="activity-cell" title="${esc(fullDate(w.activityAt))}">${ago(w.activityAt)}</td><td class="size-cell">${w.pending || w.missing ? "—" : size(w.sizeBytes)}</td><td class="action-cell"><div class="row-actions"><button class="row-action" data-delete="${esc(w.id)}" aria-label="Delete ${esc(w.path)}" ${blocked() || !state.revision ? "disabled" : ""}>Delete</button><button class="icon-button row-menu" data-worktree-menu="${esc(w.id)}" aria-label="Actions for ${esc(w.path)}" title="Worktree actions">${icon("more")}</button></div></td></tr>`;
      })
      .join("");
    $("#table-scroll").scrollTop = scroll;
    renderControls();
  }
  function renderSelection() {
    document.querySelectorAll(".worktree-row").forEach((row) => {
      row.classList.toggle("selected", selection.has(row.dataset.id));
      row.setAttribute("aria-selected", String(selection.has(row.dataset.id)));
    });
  }
  function scanProgressText() {
    const p = state.progress || {};
    if (state.cancelRequested) return "Stopping scan…";
    if (state.cancelled && !state.busy) return "Scan stopped";
    if (removing && p.stage === "removing")
      return "Removing selected worktrees…";
    return (
      {
        starting: "Starting scan…",
        discovery: "Finding Git repositories…",
        fetch: "Fetching remote branches…",
        inspect: "Inspecting worktrees…",
        connecting: "Connecting to SSH host…",
        removing: "Removing selected worktrees…",
      }[p.stage] || "Scanning workspace…"
    );
  }
  function renderProgress() {
    const active = state.busy || state.cancelled;
    $("#scan-progress").hidden = !active;
    document.body.classList.toggle("scan-active", active);
    const p = state.progress || {};
    const stage = scanProgressText();
    $("#progress-stage").textContent = stage;
    const currentPath = p.path || state.root || "";
    $("#progress-path").textContent =
      state.cancelled && !state.busy
        ? `${items().length} ${items().length === 1 ? "worktree" : "worktrees"} found. Scan again to finish checks; cleanup stays disabled.`
        : currentPath;
    $("#progress-path").title = currentPath;
    const elapsed = Number.isFinite(p.startedAt)
      ? Math.max(0, Math.floor((Date.now() - p.startedAt) / 1000))
      : 0;
    $("#progress-elapsed").textContent =
      state.busy && p.startedAt
        ? elapsed < 60
          ? `${elapsed}s elapsed`
          : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`
        : "";
    const totalKnown =
      Number.isFinite(p.total) &&
      p.total > 0 &&
      ["fetch", "inspect"].includes(p.stage);
    const completed = Math.max(0, Number(p.completed) || 0);
    const countText = totalKnown
      ? `${completed} of ${p.total} ${p.stage === "fetch" ? "repositories" : "worktrees"}`
      : Number(p.discovered) > 0
        ? `${p.discovered} discovered`
        : "";
    $("#progress-counts").textContent =
      state.cancelled && !state.busy ? "" : countText;
    const meter = $("#progress-meter");
    meter.hidden = !state.busy;
    if (totalKnown) {
      meter.max = p.total;
      meter.value = Math.min(completed, p.total);
    } else meter.removeAttribute("value");
    meter.setAttribute(
      "aria-label",
      totalKnown
        ? `${completed} of ${p.total} ${p.stage === "fetch" ? "repositories fetched" : "worktrees inspected"}`
        : stage,
    );
    $("#stop-scan").hidden =
      !state.busy || (!state.canCancelScan && !state.cancelRequested);
    $("#stop-scan").disabled = !!state.cancelRequested;
    $("#stop-scan").textContent = state.cancelRequested
      ? "Stopping…"
      : "Stop scan";
    $("#settings-progress").hidden = !state.busy;
    $("#settings-progress").textContent = state.busy
      ? `${stage}${countText ? ` ${countText}.` : ""} You can edit these settings now. To start another scan, wait for this one to finish or close Settings and use Stop scan in the main window.`
      : "";
  }
  const readExcludes = (selector) =>
    $(selector)
      .value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  function setupOptions() {
    return {
      root: $("#setup-root").value.trim(),
      host: $("#setup-remote").checked ? $("#setup-host").value.trim() : "",
      github: $("#setup-github").checked,
      fetch: $("#setup-fetch").checked,
      excludes: readExcludes("#setup-excludes"),
    };
  }
  function renderSetupStep(focus = true) {
    const titles = [
      "Choose your workspace",
      "Set your scan preferences",
      "Ready to scan",
    ];
    const descriptions = [
      "Start with the machine and folder where you keep your Git projects.",
      "Choose how much to check. These settings are saved for future scans.",
      "Review your choices. You can change them later in Settings.",
    ];
    $("#setup-title").textContent = titles[setupStep - 1];
    $("#setup-description").textContent = descriptions[setupStep - 1];
    $("#setup-step-label").textContent = `${setupStep} of 3`;
    $("#setup-dialog").dataset.step = String(setupStep);
    [1, 2, 3].forEach((step) => {
      $(`#setup-step-${step}`).hidden = step !== setupStep;
    });
    $("#setup-back").hidden = setupStep === 1;
    $("#setup-next").hidden = setupStep === 3;
    $("#setup-start").hidden = setupStep !== 3;
    $("#setup-error").hidden = true;
    if (setupStep === 3) {
      const options = setupOptions();
      $("#setup-review-machine").textContent = options.host || "This computer";
      $("#setup-review-root").textContent = options.root;
      $("#setup-review-github").textContent = options.github
        ? "On · network requests"
        : "Off · local Git data";
      $("#setup-review-fetch").textContent = options.fetch
        ? "On · fetch each repository"
        : "Off · cached references";
      $("#setup-review-excludes").textContent = options.excludes.length
        ? `${options.excludes.length} entries`
        : "None · scan all directories";
      $("#setup-review-excludes").title = options.excludes.join("\n");
      $("#setup-review-theme").textContent =
        $("#setup-theme").selectedOptions[0].textContent;
    }
    if (focus) {
      $("#setup-dialog").scrollTop = 0;
      $("#setup-title").focus({ preventScroll: true });
    }
  }
  function openSetup() {
    if (!state.setupRequired) return;
    document.querySelectorAll("dialog[open]").forEach((dialog) => {
      if (dialog.id !== "setup-dialog") dialog.close();
    });
    if (!setupInitialized) {
      setupInitialized = true;
      $("#setup-root").value = state.root || prefs.scan?.root || "~";
      $("#setup-theme").value = prefs.theme;
      $("#setup-excludes").value = desiredExcludes.join("\n");
      $("#setup-github").checked = false;
      $("#setup-fetch").checked = false;
      renderSetupStep(false);
    }
    if (!$("#setup-dialog").open) {
      $("#setup-dialog").showModal();
      $("#setup-local").focus();
    }
  }
  function validateSetupLocation() {
    if (!$("#setup-root").value.trim()) {
      $("#setup-root").focus();
      $("#setup-root").reportValidity();
      return false;
    }
    if (
      $("#setup-remote").checked &&
      !/^[a-zA-Z0-9_][a-zA-Z0-9._@:\[\]-]*$/.test($("#setup-host").value.trim())
    ) {
      $("#setup-error").textContent =
        "Enter an SSH alias or user@hostname, without spaces or command options.";
      $("#setup-error").hidden = false;
      $("#setup-host").focus();
      return false;
    }
    return true;
  }
  async function scan(options, activate = false) {
    if (
      activate
        ? !connected || removing || state.setupRequired || resettingPreferences
        : blocked()
    )
      return;
    options = {
      ...options,
      excludes: options.excludes || [...desiredExcludes],
    };
    clientError = "";
    dismissedError = "";
    const generation = ++pollGeneration;
    clearTimeout(pollTimer);
    const oldHost = state.host;
    state.busy = true;
    render();
    try {
      const next = await (activate
        ? window.arbor.activateWorkspace(options)
        : window.arbor.scan(options));
      if (generation !== pollGeneration) return;
      desiredGitHub = !!options.github;
      desiredFetch = !!options.fetch;
      desiredExcludes = [...options.excludes];
      prefs.scan = { ...options };
      if ((options.host || "") !== oldHost) {
        view = "all";
        repo = "";
        selection.clear();
        anchor = "";
      }
      updateState(next);
      if (options.host) {
        const h = prefs.hosts.find((h) => h.host === options.host);
        if (h) h.root = options.root;
      } else if (options.root) {
        prefs.roots = [
          options.root,
          ...prefs.roots.filter((r) => r !== options.root),
        ].slice(0, 8);
      }
      await savePrefs();
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 500);
    } catch (error) {
      if (generation !== pollGeneration) return;
      state.busy = false;
      showError(error.message);
      render();
      pollTimer = setTimeout(poll, 700);
    }
  }
  function refresh() {
    scan({
      root: state.root,
      host: state.host,
      github: desiredGitHub,
      fetch: desiredFetch,
    });
  }
  function openSettings() {
    if (state.setupRequired) {
      openSetup();
      return;
    }
    $("#scan-root").value = state.root || "~";
    $("#scan-github").checked = desiredGitHub;
    $("#scan-fetch").checked = desiredFetch;
    $("#scan-excludes").value = desiredExcludes.join("\n");
    $("#theme-select").value = prefs.theme;
    $("#choose-folder").hidden = !!state.host;
    $("#root-help").textContent = state.host
      ? `Search folder on ${state.host}. Use ~ for your remote home folder.`
      : "Discover Git repositories and registered worktrees in this folder.";
    if (!$("#settings-dialog").open) $("#settings-dialog").showModal();
    renderProgress();
  }
  function openMachines() {
    if (blocked()) return;
    $("#machine-list").innerHTML = [
      { host: "", name: "This computer" },
      ...prefs.hosts,
    ]
      .map(
        (h) =>
          `<div class="machine-row"><button class="machine-option${h.host === state.host ? " active" : ""}" data-host="${esc(h.host)}">${icon(h.host ? "server" : "monitor")}<span>${esc(h.name || h.host)}</span>${h.host === state.host ? icon("check") : ""}</button>${h.host ? `<button class="icon-button" data-forget-host="${esc(h.host)}" title="Forget saved host" aria-label="Forget ${esc(h.host)}">${icon("close")}</button>` : ""}</div>`,
      )
      .join("");
    if (!$("#machine-dialog").open) $("#machine-dialog").showModal();
  }
  const statisticCount = (value) =>
    Number.isFinite(value) && value >= 0 ? value : 0;
  function statisticsChart(days, field, label, format) {
    const maximum = Math.max(
      1,
      ...days.map((day) => statisticCount(day[field])),
    );
    const bars = days
      .map((day, i) => {
        const value = statisticCount(day[field]),
          height = (value / maximum) * 74;
        return `<rect class="statistics-bar${value ? "" : " empty"}" x="${i * 10 + 2}" y="${80 - Math.max(2, height)}" width="6" height="${Math.max(2, height)}" rx="2"><title>${esc(day.date)}: ${esc(format(value))}</title></rect>`;
      })
      .join("");
    const total = days.reduce(
      (sum, day) => sum + statisticCount(day[field]),
      0,
    );
    return `<section class="statistics-chart-card"><div class="statistics-chart-heading"><h3>${esc(label)}</h3><strong>${esc(format(total))}</strong></div><svg class="statistics-chart" data-testid="statistics-chart" viewBox="0 0 300 86" role="img" aria-label="${esc(label)} in the last 30 days: ${esc(format(total))}"><path class="statistics-grid" d="M0 6h300M0 43h300M0 80h300"/>${bars}</svg><div class="statistics-axis"><span>30 days ago</span><span>Today</span></div></section>`;
  }
  let statisticsGeneration = 0;
  async function openStatistics() {
    const generation = ++statisticsGeneration;
    const content = $("#statistics-content"),
      dialog = $("#statistics-dialog");
    content.innerHTML = '<p class="statistics-loading">Loading statistics…</p>';
    if (!dialog.open) dialog.showModal();
    try {
      const { host, report } = await window.arbor.getStats();
      if (
        generation !== statisticsGeneration ||
        !dialog.open ||
        host !== state.host
      )
        return;
      const removed = statisticCount(report.removedWorktrees),
        bytes = statisticCount(report.estimatedBytesReclaimed);
      const missing = statisticCount(report.missingRegistrations);
      const dayMap = new Map(report.daily.map((day) => [day.date, day]));
      const today = new Date();
      const days = Array.from({ length: 30 }, (_, i) => {
        const date = new Date(
          Date.UTC(
            today.getUTCFullYear(),
            today.getUTCMonth(),
            today.getUTCDate() - 29 + i,
          ),
        )
          .toISOString()
          .slice(0, 10);
        return dayMap.get(date) || { date };
      });
      const card = (value, label) =>
        `<div class="statistics-metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
      content.innerHTML = `<div class="statistics-scope">${icon(host ? "server" : "monitor")}<span>${esc(host || "This computer")}</span><span class="statistics-lifetime">All time</span></div>
        <div class="statistics-hero"><div><span class="statistics-eyebrow">A little more breathing room</span><strong data-stat="estimatedBytesReclaimed">${esc(size(bytes))}</strong><span>estimated space recovered</span></div><div class="statistics-removed"><strong data-stat="removedWorktrees">${removed.toLocaleString()}</strong><span>worktrees cleaned up</span></div></div>
        <div class="statistics-metrics">${card(statisticCount(report.cleanupSessions).toLocaleString(), "Cleanup sessions")}${card(size(report.largestWorktreeBytes), "Largest checkout")}${card(size(removed > missing ? bytes / (removed - missing) : 0), "Average checkout")}</div>
        <div class="statistics-charts">${statisticsChart(days, "removedWorktrees", "Worktrees cleaned up", (n) => n.toLocaleString())}${statisticsChart(days, "estimatedBytesReclaimed", "Space recovered", size)}</div>
        ${!removed ? '<p class="statistics-empty">Your next cleanup starts the story. Successful deletions from the app and CLI will appear here.</p>' : `<div class="statistics-detail"><span>Last cleanup</span><strong>${esc(fullDate(report.lastCleanupAt))}</strong></div><div class="statistics-detail"><span>Missing registrations cleaned up</span><strong>${missing.toLocaleString()}</strong></div><div class="statistics-detail"><span>Detached commits retained</span><strong>${statisticCount(report.detachedCommitsRetained).toLocaleString()}</strong></div>`}
        <p class="statistics-note">Space is estimated from checkout sizes at deletion, not a measurement of free disk space. Missing checkouts count as zero bytes. Charts use UTC dates.</p>
        ${report.warning ? `<p class="statistics-warning">${esc(report.warning)}</p>` : ""}`;
      $("#statistics-dialog .statistics-footer").textContent =
        `Desktop + CLI · Stored ${host ? "on this SSH host" : "on this computer"} · No worktree path history`;
    } catch (error) {
      if (generation !== statisticsGeneration || !dialog.open) return;
      content.innerHTML = `<p class="statistics-warning">${esc(error.message || "Statistics could not be loaded.")}</p>`;
    }
  }
  function switchHost(host) {
    $("#machine-dialog").close();
    if (host === state.host) return;
    const root = host
      ? prefs.hosts.find((h) => h.host === host)?.root || "~"
      : prefs.roots[0] || "";
    scan(
      {
        root,
        host,
        github: desiredGitHub,
        fetch: desiredFetch,
        excludes: [...desiredExcludes],
      },
      true,
    );
  }
  async function remove(list, recommendedOnly, options = {}) {
    if (blocked() || !state.revision || !list.length) return;
    const revision = state.revision;
    removing = true;
    clientError = "";
    pollGeneration++;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 350);
    renderControls();
    try {
      const result = await window.arbor.remove({
        items: list.map((w) => ({ id: w.id, head: w.head })),
        recommendedOnly,
        revision,
        discardLocal: options.discardLocal === true,
        forceConfirm: options.forceConfirm === true,
      });
      if (Object.hasOwn(result, "report")) state.report = result.report;
      if (Object.hasOwn(result, "revision")) state.revision = result.revision;
      if (result.error) showError(result.error);
      const removed = (result.results || []).filter((r) => r.removed),
        failed = (result.results || []).filter((r) => !r.removed);
      if (removed.length) {
        notify(
          `Deleted ${removed.length} ${removed.length === 1 ? "worktree folder" : "worktree folders"}.`,
        );
        const removedPaths = new Set(removed.map((r) => r.path));
        for (const w of list)
          if (removedPaths.has(w.path)) selection.delete(w.id);
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
        updateState(await window.arbor.getState());
      } catch (error) {
        connected = false;
        showError(`Could not refresh Arbor after deletion: ${error.message}`);
      }
      removing = false;
      render();
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
  async function showWorktreeMenu(id) {
    const worktree = items().find((w) => w.id === id);
    if (!worktree) return;
    try {
      await window.arbor.showWorktreeMenu({ id, revision: state.revision });
    } catch (error) {
      notify(error.message, true);
    }
  }
  function selectRow(id, event) {
    const previous = anchor;
    cursor = id;
    if (event.shiftKey && previous) {
      const a = visible.findIndex((w) => w.id === previous),
        b = visible.findIndex((w) => w.id === id);
      if (a >= 0 && b >= 0) {
        if (!event.metaKey && !event.ctrlKey) selection.clear();
        visible
          .slice(Math.min(a, b), Math.max(a, b) + 1)
          .forEach((w) => selection.add(w.id));
      }
    } else if (event.metaKey || event.ctrlKey) {
      selection.has(id) ? selection.delete(id) : selection.add(id);
      anchor = id;
    } else {
      selection = new Set([id]);
      anchor = id;
    }
    renderSelection();
    renderControls();
    $("#worktree-list").focus({ preventScroll: true });
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) {
      if (button.disabled) return;
      if (button.dataset.close) $(`#${button.dataset.close}`).close();
      if (button.dataset.view) {
        view = button.dataset.view;
        repo = "";
        selection.clear();
        render();
      }
      if (button.dataset.repo !== undefined) {
        repo = repo === button.dataset.repo ? "" : button.dataset.repo;
        view = "all";
        selection.clear();
        render();
      }
      if (button.dataset.sort) {
        if (sort === button.dataset.sort) descending = !descending;
        else {
          sort = button.dataset.sort;
          descending = ["activity", "size"].includes(sort);
        }
        renderRows();
      }
      if (button.dataset.toggleDirectory) {
        const path = button.dataset.toggleDirectory;
        if (collapsedDirectories.has(path)) collapsedDirectories.delete(path);
        else collapsedDirectories.add(path);
        renderRows();
        document
          .querySelector(`[data-toggle-directory="${CSS.escape(path)}"]`)
          ?.focus({ preventScroll: true });
      }
      if (button.dataset.folderDelete)
        deleteWorktrees(
          tree.folderWorktrees(directoryRows, button.dataset.folderDelete),
        );
      if (button.dataset.delete) {
        const w = items().find((w) => w.id === button.dataset.delete);
        if (w) deleteWorktrees([w]);
      }
      if (button.dataset.worktreeMenu)
        showWorktreeMenu(button.dataset.worktreeMenu);
      if (button.dataset.host !== undefined) switchHost(button.dataset.host);
      if (button.dataset.forgetHost) {
        prefs.hosts = prefs.hosts.filter(
          (h) => h.host !== button.dataset.forgetHost,
        );
        savePrefs();
        openMachines();
      }
      if (button.hasAttribute("data-open-settings")) openSettings();
      return;
    }
    const row = event.target.closest("[data-id]");
    if (row) selectRow(row.dataset.id, event);
  });
  $("#worktree-list").addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    event.preventDefault();
    if (!selection.has(row.dataset.id)) selectRow(row.dataset.id, event);
    showWorktreeMenu(row.dataset.id);
  });
  $("#worktree-list").addEventListener("keydown", (event) => {
    const directoryButton = event.target.closest("[data-toggle-directory]");
    if (directoryButton && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const path = directoryButton.dataset.toggleDirectory;
      if (event.key === "ArrowLeft") collapsedDirectories.add(path);
      else collapsedDirectories.delete(path);
      renderRows();
      document
        .querySelector(`[data-toggle-directory="${CSS.escape(path)}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    if (event.target.closest("button")) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!visible.length) return;
      let index = visible.findIndex((w) => w.id === cursor);
      index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? visible.length - 1
            : event.key === "ArrowDown"
              ? Math.min(visible.length - 1, index + 1)
              : Math.max(0, index - 1);
      selectRow(visible[index].id, event);
      document
        .querySelector(
          `.worktree-row[data-id="${CSS.escape(visible[index].id)}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
    }
    if (
      event.key === "Enter" ||
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      if (cursor) showWorktreeMenu(cursor);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "a") {
      event.preventDefault();
      selection = new Set(visible.map((w) => w.id));
      render();
    }
  });
  $("#search").oninput = (event) => {
    if (search !== event.target.value) collapsedDirectories.clear();
    search = event.target.value;
    selection.clear();
    render();
  };
  $("#tree-sort").onchange = (event) => {
    sort = event.target.value;
    descending = ["activity", "size"].includes(sort);
    renderRows();
  };
  $("#refresh-button").onclick = refresh;
  $("#cleanup-button").onclick = () =>
    remove(
      items().filter((w) => w.recommended),
      true,
    );
  $("#remove-selected").onclick = () => {
    const selected = items().filter((w) => selection.has(w.id));
    deleteWorktrees(selected);
  };
  $("#settings-button").onclick = openSettings;
  $("#statistics-button").onclick = openStatistics;
  $("#scan-options-button").onclick = openSettings;
  $("#machine-button").onclick = openMachines;
  $("#add-host").onclick = () => {
    openMachines();
    $("#host-input").focus();
  };
  $("#path-button").onclick = async () => {
    if (state.host) {
      openSettings();
      return;
    }
    try {
      const root = await window.arbor.chooseFolder();
      if (root)
        scan({ root, host: "", github: desiredGitHub, fetch: desiredFetch });
    } catch (error) {
      notify(error.message, true);
    }
  };
  $("#choose-folder").onclick = async () => {
    try {
      const root = await window.arbor.chooseFolder();
      if (root) $("#scan-root").value = root;
    } catch (error) {
      notify(error.message, true);
    }
  };
  $("#settings-form").onsubmit = async (event) => {
    event.preventDefault();
    if (blocked()) return;
    prefs.theme = $("#theme-select").value;
    applyTheme();
    await savePrefs();
    $("#settings-dialog").close();
    scan({
      root: $("#scan-root").value.trim(),
      host: state.host,
      github: $("#scan-github").checked,
      fetch: $("#scan-fetch").checked,
      excludes: readExcludes("#scan-excludes"),
    });
  };
  $("#theme-button").onclick = () => {
    prefs.theme =
      { system: "light", light: "dark", dark: "system" }[prefs.theme] ||
      "system";
    applyTheme();
    savePrefs();
  };
  $("#host-form").onsubmit = async (event) => {
    event.preventDefault();
    const host = $("#host-input").value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._@:-]*$/.test(host)) {
      notify(
        "Enter an SSH alias or user@hostname without spaces or options.",
        true,
      );
      return;
    }
    if (!prefs.hosts.some((h) => h.host === host))
      prefs.hosts.push({ name: host, host, root: "~" });
    await savePrefs();
    $("#host-input").value = "";
    switchHost(host);
  };
  $("#warning-button").onclick = () => {
    $("#notes-content").innerHTML = (state.report?.warnings || [])
      .map(
        (w) =>
          `<p class="detail-note warning">${icon("warning")}<span>${esc(w)}</span></p>`,
      )
      .join("");
    $("#notes-dialog").showModal();
  };
  $("#dismiss-error").onclick = () => {
    dismissedError = clientError || state.error;
    renderError();
  };
  function menu(action) {
    if (resettingPreferences) return;
    if (state.setupRequired) {
      openSetup();
      return;
    }
    if (action && typeof action === "object") {
      if (action.type === "worktree-remove") {
        if (!action.revision || action.revision !== state.revision) {
          notify("The scan changed. Try deleting the worktree again.", true);
          return;
        }
        const w = items().find((w) => w.id === action.id);
        if (w) deleteWorktrees([w]);
      }
      return;
    }
    if (action === "refresh") refresh();
    if (action === "settings") openSettings();
    if (action === "statistics") openStatistics();
    if (action === "focus-search") {
      $("#search").focus();
      $("#search").select();
    }
    if (action === "add-host") {
      openMachines();
      $("#host-input").focus();
    }
  }
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement.tagName,
      ) &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      menu("focus-search");
    }
  });
  $("#scan-reset-excludes").onclick = () => {
    $("#scan-excludes").value = defaultExcludes.join("\n");
  };
  $("#setup-reset-excludes").onclick = () => {
    $("#setup-excludes").value = defaultExcludes.join("\n");
  };
  $("#reset-preferences").onclick = async () => {
    if ($("#reset-preferences").disabled) return;
    resettingPreferences = true;
    pollGeneration++;
    clearTimeout(pollTimer);
    renderControls();
    try {
      const result = await window.arbor.resetPreferences();
      if (result.cancelled) return;
      document
        .querySelectorAll("dialog[open]")
        .forEach((dialog) => dialog.close());
      prefs = { ...result.preferences };
      desiredGitHub = !!prefs.scan?.github;
      desiredFetch = !!prefs.scan?.fetch;
      desiredExcludes = [...(prefs.scan?.excludes || defaultExcludes)];
      view = "all";
      repo = "";
      search = "";
      sort = "path";
      descending = false;
      collapsedDirectories.clear();
      $("#search").value = "";
      selection.clear();
      anchor = "";
      cursor = "";
      clientError = "";
      dismissedError = "";
      setupStep = 1;
      setupInitialized = false;
      setupSubmitting = false;
      setupMachine = "local";
      setupRoots = { local: "", remote: "~" };
      $("#setup-form").reset();
      $("#setup-dialog").scrollTop = 0;
      $("#settings-form").reset();
      $("#host-form").reset();
      $("#setup-host-field").hidden = true;
      $("#setup-choose-folder").hidden = false;
      $("#setup-start").disabled = false;
      $("#setup-back").disabled = false;
      $("#setup-start").textContent = "Start scanning";
      $("#scan-excludes").value = desiredExcludes.join("\n");
      $("#scan-root").value = result.state.root || prefs.scan?.root || "~";
      $("#scan-github").checked = desiredGitHub;
      $("#scan-fetch").checked = desiredFetch;
      $("#toast-region").replaceChildren();
      resettingPreferences = false;
      applyTheme();
      updateState(result.state);
    } catch (error) {
      notify(`Could not reset settings: ${error.message}`, true);
    } finally {
      resettingPreferences = false;
      renderControls();
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 700);
    }
  };
  $("#stop-scan").onclick = async () => {
    if (!state.busy || !state.canCancelScan || state.cancelRequested) return;
    state.cancelRequested = true;
    renderProgress();
    try {
      updateState(await window.arbor.cancelScan());
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 350);
    } catch (error) {
      state.cancelRequested = false;
      showError(error.message);
      renderProgress();
    }
  };
  $("#setup-dialog").addEventListener("cancel", (event) =>
    event.preventDefault(),
  );
  $("#setup-dialog").addEventListener("close", () => {
    if (state.setupRequired && !setupSubmitting && !resettingPreferences)
      openSetup();
  });
  let setupMachine = "local",
    setupRoots = { local: "", remote: "~" };
  function changeSetupMachine() {
    setupRoots[setupMachine] = $("#setup-root").value;
    setupMachine = $("#setup-remote").checked ? "remote" : "local";
    $("#setup-root").value = setupRoots[setupMachine] || state.root || "~";
    $("#setup-host-field").hidden = setupMachine !== "remote";
    $("#setup-choose-folder").hidden = setupMachine === "remote";
    if (setupMachine === "remote") $("#setup-host").focus();
  }
  $("#setup-local").onchange = changeSetupMachine;
  $("#setup-remote").onchange = changeSetupMachine;
  $("#setup-choose-folder").onclick = async () => {
    try {
      const root = await window.arbor.chooseFolder();
      if (root) $("#setup-root").value = root;
    } catch (error) {
      $("#setup-error").textContent = error.message;
      $("#setup-error").hidden = false;
    }
  };
  $("#setup-next").onclick = () => {
    if (setupSubmitting || (setupStep === 1 && !validateSetupLocation()))
      return;
    if (setupStep < 3) {
      setupStep++;
      renderSetupStep();
    }
  };
  $("#setup-back").onclick = () => {
    if (!setupSubmitting && setupStep > 1) {
      setupStep--;
      renderSetupStep();
    }
  };
  $("#setup-theme").onchange = () => {
    prefs.theme = $("#setup-theme").value;
    applyTheme();
  };
  $("#setup-form").onsubmit = async (event) => {
    event.preventDefault();
    if (setupStep < 3) {
      $("#setup-next").click();
      return;
    }
    if (setupSubmitting || !validateSetupLocation()) return;
    setupSubmitting = true;
    $("#setup-start").disabled = true;
    $("#setup-back").disabled = true;
    $("#setup-start").textContent = "Starting…";
    $("#setup-error").hidden = true;
    const options = setupOptions();
    prefs.theme = $("#setup-theme").value;
    prefs.scan = { ...options };
    if (options.host) {
      const host = prefs.hosts.find((h) => h.host === options.host);
      if (host) host.root = options.root;
      else
        prefs.hosts.push({
          name: options.host,
          host: options.host,
          root: options.root,
        });
    } else
      prefs.roots = [
        options.root,
        ...prefs.roots.filter((root) => root !== options.root),
      ].slice(0, 8);
    try {
      await window.arbor.savePreferences(prefs);
      const next = await window.arbor.completeSetup(options);
      prefs.setupCompleted = true;
      desiredExcludes = [...options.excludes];
      desiredGitHub = options.github;
      desiredFetch = options.fetch;
      applyTheme();
      updateState(next);
      $("#setup-dialog").close();
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 350);
    } catch (error) {
      $("#setup-error").textContent = error.message;
      $("#setup-error").hidden = false;
    } finally {
      setupSubmitting = false;
      $("#setup-start").disabled = false;
      $("#setup-back").disabled = false;
      $("#setup-start").textContent = "Start scanning";
    }
  };
  async function initialize() {
    try {
      if (!window.arbor)
        throw new Error(
          "Open Arbor as a desktop app to connect to your workspace.",
        );
      const [saved, initial] = await Promise.all([
        window.arbor.getPreferences(),
        window.arbor.getState(),
      ]);
      prefs = { ...prefs, ...saved };
      prefs.hosts = Array.isArray(prefs.hosts)
        ? prefs.hosts.filter((h) => h && typeof h.host === "string")
        : [];
      prefs.roots = Array.isArray(prefs.roots) ? prefs.roots : [];
      if (!["system", "light", "dark"].includes(prefs.theme))
        prefs.theme = "system";
      applyTheme();
      desiredGitHub = !!(
        initial.options?.github ??
        prefs.scan?.github ??
        initial.report?.github
      );
      desiredFetch = !!(
        initial.options?.fetch ??
        prefs.scan?.fetch ??
        initial.report?.fetched
      );
      desiredExcludes = [
        ...(initial.options?.excludes ||
          prefs.scan?.excludes ||
          defaultExcludes),
      ];
      updateState(initial);
      window.arbor.onMenuAction(menu);
      pollTimer = setTimeout(poll, initial.busy ? 500 : 2000);
    } catch (error) {
      showError(error.message);
      render();
    }
  }
  render();
  initialize();
})();
