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
    "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    shield:
      '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
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
    cloud: '<path d="M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 2 4 4 0 0 1-1 8H7Z"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    warning: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
    external:
      '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
    moon: '<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z"/>',
    panel:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
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
    sort = "activity",
    descending = true;
  let selection = new Set(),
    anchor = "",
    cursor = "",
    inspector = false,
    connected = false,
    removing = false,
    clientError = "",
    dismissedError = "";
  let pollTimer,
    rowSignature = "",
    repoSignature = "",
    detailSignature = "",
    visible = [],
    desiredFetch = false,
    desiredGitHub = false,
    desiredExcludes = [...defaultExcludes],
    setupStep = 1,
    setupInitialized = false,
    setupSubmitting = false;
  const items = () => state.report?.worktrees || state.partialWorktrees || [];
  const blocked = () =>
    !connected || state.busy || removing || state.setupRequired;
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
  const badge = (text, color = "", symbol = "") =>
    `<span class="badge${color ? ` badge-${color}` : ""}">${symbol ? icon(symbol) : ""}${esc(text)}</span>`;
  function badges(w) {
    if (w.pending)
      return `<span class="badge badge-pending">${icon(state.cancelled ? "info" : "refresh", state.cancelled ? "" : "spinning")}${state.cancelled ? "Not checked" : "Checking…"}</span>`;
    const result = [];
    if (w.main) result.push(badge("Main", "", "lock"));
    else if (w.bare) result.push(badge("Bare"));
    else if (w.locked) result.push(badge("Locked", "", "lock"));
    else if (w.merged) result.push(badge("Merged", "green", "merge"));
    if (w.dirty) result.push(badge(`${w.changedFiles || 1} changed`, "orange"));
    else if (w.ignored) result.push(badge("Ignored files", "orange"));
    if (w.githubState === "verified")
      result.push(
        badge(
          w.pr?.merged ? `PR #${w.pr.number}` : "GitHub",
          "purple",
          "check",
        ),
      );
    else if (w.published && !w.main)
      result.push(
        badge(
          state.report?.fetched ? "Pushed" : "Pushed · cached",
          "",
          "cloud",
        ),
      );
    else if (!w.published && !w.main && !w.bare && !w.locked)
      result.push(badge("Push unverified"));
    if (w.missing) result.push(badge("Missing", "orange"));
    if (w.outsideRoot) result.push(badge("Outside scan"));
    return result.join("");
  }
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
    if (state.setupRequired) openSetup();
  }
  async function poll() {
    clearTimeout(pollTimer);
    try {
      updateState(await window.arbor.getState());
    } catch (error) {
      connected = false;
      showError(error.message || "Could not connect to the Arbor backend.");
      renderControls();
    }
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
      `${icon(removing ? "refresh" : "cleanup", removing ? "spinning" : "")}<span>${removing ? "Removing…" : `Clean up${ready.length ? ` (${ready.length})` : ""}`}</span>`;
    $("#cleanup-button").title =
      `Remove ${ready.length} recommended worktrees on ${machineName()} and reclaim ${size(sizeOf(ready))}. Branches are kept.`;
    document.querySelectorAll("[data-remove]").forEach((b) => {
      const w = items().find((w) => w.id === b.dataset.remove);
      b.disabled = disabled || !state.revision || !w?.canRemove || !!w?.pending;
    });
    $("#selection-bar").hidden = selection.size < 2;
    $("#selection-label").textContent = `${selection.size} worktrees selected`;
    $("#remove-selected").disabled =
      disabled ||
      !selection.size ||
      !state.revision ||
      items()
        .filter((w) => selection.has(w.id))
        .some((w) => !w.canRemove);
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
    $("#protected-count").textContent = list.filter(
      (w) => !w.canRemove && !w.pending,
    ).length;
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
    $("#verification-label").textContent = state.report?.github
      ? `GitHub checked · ${state.report.fetched ? "remotes fetched" : "cached refs"}`
      : state.report?.fetched
        ? "Remote branches fetched"
        : "Local Git metadata · cached refs";
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
          protected: "Protected",
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
      ? `Scanned ${ago(state.report.scannedAt).toLowerCase()}`
      : "";
    $("#scan-time").title = state.report
      ? `${fullDate(state.report.scannedAt)} · ${state.report.durationMs} ms`
      : "";
    renderError();
    renderProgress();
    renderRows();
    renderInspector();
    renderControls();
  }
  function renderRows() {
    const query = search.trim().toLowerCase();
    visible = items().filter(
      (w) =>
        (!repo || repoID(w) === repo) &&
        (view !== "recommended" || w.recommended) &&
        (view !== "protected" || (!w.canRemove && !w.pending)) &&
        (!query ||
          [w.branch, w.repo, w.path, w.head, w.subject].some((v) =>
            (v || "").toLowerCase().includes(query),
          )),
    );
    visible.sort((a, b) => {
      let compare =
        sort === "branch"
          ? branchName(a).localeCompare(branchName(b))
          : sort === "repo"
            ? (a.repo || "").localeCompare(b.repo || "") ||
              branchName(a).localeCompare(branchName(b))
            : sort === "size"
              ? (a.sizeBytes || 0) - (b.sizeBytes || 0)
              : (parsedDate(a.activityAt)?.valueOf() || 0) -
                (parsedDate(b.activityAt)?.valueOf() || 0);
      return compare * (descending ? -1 : 1);
    });
    $("#visible-count").textContent = visible.length;
    document.querySelectorAll("[data-sort]").forEach((b) => {
      b.parentElement.classList.toggle("sorted", b.dataset.sort === sort);
      b.parentElement.setAttribute(
        "aria-sort",
        b.dataset.sort === sort
          ? descending
            ? "descending"
            : "ascending"
          : "none",
      );
    });
    const signature = JSON.stringify([
      visible,
      sort,
      descending,
      view,
      search,
      repo,
      state.report?.fetched,
      state.busy,
      connected,
      removing,
      state.cancelled,
      visible.map((w) => ago(w.activityAt)),
    ]);
    if (signature === rowSignature) {
      renderSelection();
      return;
    }
    rowSignature = signature;
    $("#empty-state").hidden = visible.length > 0;
    if (!visible.length) {
      const loading = state.busy || (!connected && !clientError);
      let heading = loading
        ? "Scanning workspace…"
        : !items().length
          ? "No worktrees found"
          : "No matching worktrees";
      let text = loading
        ? state.host
          ? "Connecting over SSH and preparing the remote CLI."
          : "Discovering Git repositories and their worktrees."
        : !items().length
          ? "Choose a folder containing Git repositories to get started."
          : "Try another search or select a different view.";
      if (view === "recommended" && items().length && !query && !repo) {
        heading = "No cleanup recommended";
        text =
          "Worktrees appear here when they are clean and their commits are already merged.";
      }
      $("#empty-state").innerHTML =
        `${icon(loading ? "refresh" : "trees", loading ? "spinning" : "")}<h2>${heading}</h2><p>${text}</p>${!loading && !items().length ? '<button class="button" data-open-settings>Choose scan folder</button>' : ""}`;
    }
    const scroll = $("#table-scroll").scrollTop;
    $("#worktree-list").innerHTML = visible
      .map(
        (w) =>
          `<tr class="worktree-row${selection.has(w.id) ? " selected" : ""}" data-id="${esc(w.id)}" aria-selected="${selection.has(w.id)}"><td class="branch-cell"><div class="branch-cell-inner">${icon(w.main ? "folder" : w.merged ? "merge" : "branch", w.merged && !w.main ? "merged-icon" : "")}<div class="branch-copy"><span class="branch-name" title="${esc(branchName(w))}">${esc(branchName(w))}</span><span class="branch-commit">${esc((w.head || "").slice(0, 7))}</span></div></div></td><td class="repo-cell" title="${esc(w.commonDir)}">${esc(w.repo)}</td><td class="status-cell"><div class="badges">${badges(w)}</div></td><td class="activity-cell" title="${esc(fullDate(w.activityAt))}">${ago(w.activityAt)}</td><td class="size-cell">${size(w.sizeBytes)}</td><td class="action-cell"><button class="icon-button row-delete" data-remove="${esc(w.id)}" ${blocked() || !w.canRemove ? "disabled" : ""} aria-label="Remove ${esc(branchName(w))}" title="${esc(w.canRemove ? "Remove worktree; retain branch" : [...(w.blockers || []), ...(w.problems || [])].join("; ") || "Protected worktree")}">${icon(w.canRemove ? "trash" : "lock")}</button></td></tr>`,
      )
      .join("");
    $("#table-scroll").scrollTop = scroll;
    for (const w of visible.filter((w) => w.pending)) {
      const row = document.querySelector(
        `.worktree-row[data-id="${CSS.escape(w.id)}"]`,
      );
      row.classList.add("pending-row");
      row.querySelector(".branch-commit").textContent = state.cancelled
        ? "Inspection incomplete"
        : "Checking metadata…";
      row.querySelector(".size-cell").textContent = "—";
      const button = row.querySelector("[data-remove]");
      button.innerHTML = icon(
        state.cancelled ? "info" : "refresh",
        state.cancelled ? "" : "spinning",
      );
      button.title = state.cancelled
        ? "Scan again to complete inspection"
        : "Inspection in progress";
      button.setAttribute("aria-label", `Checking ${branchName(w)}`);
    }
    renderControls();
  }
  function renderSelection() {
    document.querySelectorAll(".worktree-row").forEach((row) => {
      row.classList.toggle("selected", selection.has(row.dataset.id));
      row.setAttribute("aria-selected", String(selection.has(row.dataset.id)));
    });
  }
  function renderInspector() {
    $("#inspector").hidden = !inspector;
    document.body.classList.toggle("inspector-open", inspector);
    $("#inspector-button").setAttribute("aria-pressed", String(inspector));
    if (!inspector) return;
    const w = items().find((w) => selection.has(w.id));
    const signature = JSON.stringify([
      w,
      state.host,
      state.report?.fetched,
      blocked(),
      selection.size,
      state.revision,
      state.cancelled,
    ]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    const header = `<div class="inspector-header"><span>Worktree details</span><button class="icon-button" data-close-inspector aria-label="Close details">${icon("close")}</button></div>`;
    if (!w || selection.size !== 1) {
      $("#inspector-content").innerHTML =
        `${header}<div class="inspector-empty">${icon("info")}${selection.size > 1 ? `${selection.size} worktrees selected.<br>Select one to inspect its metadata.` : "Select a worktree to inspect its metadata and cleanup status."}</div>`;
      return;
    }
    if (w.pending) {
      $("#inspector-content").innerHTML =
        `${header}<div class="inspector-body"><h2 class="inspector-branch">${icon("branch")}<span>${esc(branchName(w))}</span></h2><div class="inspector-path"><code>${esc(w.path)}</code></div><p class="detail-note">${icon(state.cancelled ? "info" : "refresh", state.cancelled ? "" : "spinning")}<span>${state.cancelled ? "The scan stopped before inspection finished. Scan again to check this worktree." : "Checking this worktree. Commit, change, merge, and push information will appear as inspection finishes."}</span></p></div>`;
      return;
    }
    const github =
      {
        not_checked: "Not checked",
        no_pr: "No matching PR",
        not_github: "No GitHub remote",
        unavailable: "Could not verify",
        verified: "Verified",
      }[w.githubState] || "Not checked";
    const push =
      w.githubState === "verified"
        ? "Exact commit verified on GitHub"
        : w.published
          ? `Commit found in ${state.report?.fetched ? "fetched" : "cached"} remote references`
          : "Commit not verified on a remote";
    const detailRow = (label, value) =>
      `<div class="detail-row"><span>${label}</span><span>${esc(value)}</span></div>`;
    $("#inspector-content").innerHTML =
      `${header}<div class="inspector-body"><h2 class="inspector-branch">${icon("branch")}<span>${esc(branchName(w))}</span></h2><p class="inspector-repo">${esc(w.repo)} · ${esc(machineName())}</p><div class="badges">${badges(w)}</div><div class="inspector-path"><code>${esc(w.path)}</code><button class="icon-button" data-copy="${esc(w.path)}" title="Copy path" aria-label="Copy worktree path">${icon("copy")}</button></div><section class="inspector-section"><h3>Activity</h3>${detailRow("Last active", ago(w.activityAt))}${detailRow("Disk space", size(w.sizeBytes))}${detailRow("Changed files", w.changedFiles || 0)}<p class="detail-note">Latest observed commit, Git activity, or file change. ${esc(fullDate(w.activityAt))}.</p></section><section class="inspector-section"><h3>Latest commit</h3><p class="detail-commit">${esc(w.subject || "No commit information")}</p><div class="detail-hash">${esc(w.head)}</div>${detailRow("Author", w.author || "Unknown")}${detailRow("Committed", fullDate(w.commitAt))}</section><section class="inspector-section"><h3>Remote & merge status</h3>${detailRow("Upstream", w.upstream || "Not configured")}${w.upstream ? detailRow("Tracking", `${w.ahead} ahead · ${w.behind} behind`) : ""}${detailRow("GitHub", github)}<p class="detail-note">${icon("cloud")}<span>${esc(push)}.</span></p>${(w.publishedRefs || []).length ? `<p class="detail-hash">${esc(w.publishedRefs.join(", "))}</p>` : ""}<p class="detail-note">${icon(w.merged ? "check-circle" : "info")}<span>${esc(w.merged ? w.mergeReason || "Commits are merged" : `Not verified merged${w.defaultRef ? ` into ${w.defaultRef}` : ""}`)}.</span></p>${w.pr ? `<button class="detail-link" data-external="${esc(w.pr.url)}">#${w.pr.number} ${esc(w.pr.title)} ${icon("external")}</button><p class="detail-note">${esc(w.pr.state)}</p>` : ""}</section><section class="inspector-section"><h3>Cleanup</h3>${w.recommended ? `<p class="detail-note">${icon("check-circle")}<span>Recommended: clean, merged, and safe to remove. The branch is retained.</span></p>` : ""}${(w.blockers || []).map((s) => `<p class="detail-note warning">${icon("shield")}<span>${esc(s)}</span></p>`).join("")}${(w.problems || []).map((s) => `<p class="detail-note warning">${icon("warning")}<span>${esc(s)}</span></p>`).join("")}${w.canRemove && !w.recommended ? '<p class="detail-note">Not recommended for automatic cleanup. Review unmerged commits before removing.</p>' : ""}<button class="button button-danger inspector-remove" data-remove="${esc(w.id)}" ${blocked() || !w.canRemove ? "disabled" : ""}>${icon("trash")}Remove worktree</button></section></div>`;
  }
  function scanProgressText() {
    const p = state.progress || {};
    if (state.cancelRequested) return "Stopping scan…";
    if (state.cancelled && !state.busy) return "Scan stopped";
    if (removing && p.stage === "removing")
      return "Removing selected worktrees…";
    return (
      {
        starting: removing ? "Refreshing after cleanup…" : "Starting scan…",
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
    for (const selector of ["#stop-scan", "#settings-stop-scan"]) {
      $(selector).hidden =
        !state.busy || (!state.canCancelScan && !state.cancelRequested);
      $(selector).disabled = !!state.cancelRequested;
      $(selector).textContent = state.cancelRequested
        ? "Stopping…"
        : "Stop scan";
    }
    $("#settings-progress").hidden = !state.busy;
    $("#settings-progress").textContent = state.busy
      ? `${stage}${countText ? ` ${countText}.` : ""} You can edit these settings now; wait for the current operation to finish or stop the scan before starting another.`
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
  async function scan(options) {
    if (blocked()) return;
    options = {
      ...options,
      excludes: options.excludes || [...desiredExcludes],
    };
    clientError = "";
    dismissedError = "";
    const oldHost = state.host;
    state.busy = true;
    render();
    try {
      const next = await window.arbor.scan(options);
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
      state.busy = false;
      showError(error.message);
      render();
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
  function switchHost(host) {
    $("#machine-dialog").close();
    if (host === state.host) return;
    const root = host
      ? prefs.hosts.find((h) => h.host === host)?.root || "~"
      : prefs.roots[0] || "";
    scan({ root, host, github: false, fetch: false });
  }
  async function remove(list, recommendedOnly) {
    if (blocked() || !state.revision || !list.length) return;
    const revision = state.revision;
    removing = true;
    clientError = "";
    renderControls();
    try {
      const result = await window.arbor.remove({
        items: list.map((w) => ({ id: w.id, head: w.head })),
        recommendedOnly,
        revision,
      });
      if (Object.hasOwn(result, "report")) state.report = result.report;
      if (Object.hasOwn(result, "revision")) state.revision = result.revision;
      if (result.error) showError(result.error);
      const removed = (result.results || []).filter((r) => r.removed),
        failed = (result.results || []).filter((r) => !r.removed);
      if (removed.length) {
        notify(
          `Removed ${removed.length} ${removed.length === 1 ? "worktree" : "worktrees"}. Branches retained.`,
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
      removing = false;
      render();
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
    renderInspector();
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
      if (button.dataset.remove) {
        const w = items().find((w) => w.id === button.dataset.remove);
        if (w) remove([w], w.recommended);
      }
      if (button.hasAttribute("data-close-inspector")) {
        inspector = false;
        renderInspector();
      }
      if (button.dataset.host !== undefined) switchHost(button.dataset.host);
      if (button.dataset.forgetHost) {
        prefs.hosts = prefs.hosts.filter(
          (h) => h.host !== button.dataset.forgetHost,
        );
        savePrefs();
        openMachines();
      }
      if (button.dataset.copy)
        window.arbor
          .copyText(button.dataset.copy)
          .then(() => notify("Path copied."))
          .catch((e) => notify(e.message, true));
      if (button.dataset.external)
        window.arbor
          .openExternal(button.dataset.external)
          .catch((e) => notify(e.message, true));
      if (button.hasAttribute("data-open-settings")) openSettings();
      return;
    }
    const row = event.target.closest("[data-id]");
    if (row) selectRow(row.dataset.id, event);
  });
  $("#worktree-list").addEventListener("dblclick", (event) => {
    if (event.target.closest("button")) return;
    const row = event.target.closest("[data-id]");
    if (row) {
      selection = new Set([row.dataset.id]);
      inspector = true;
      render();
    }
  });
  $("#worktree-list").addEventListener("keydown", (event) => {
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
    if (event.key === "Enter") {
      event.preventDefault();
      inspector = true;
      renderInspector();
      renderControls();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "a") {
      event.preventDefault();
      selection = new Set(visible.map((w) => w.id));
      render();
    }
  });
  $("#search").oninput = (event) => {
    search = event.target.value;
    selection.clear();
    render();
  };
  $("#refresh-button").onclick = refresh;
  $("#cleanup-button").onclick = () =>
    remove(
      items().filter((w) => w.recommended),
      true,
    );
  $("#remove-selected").onclick = () => {
    const selected = items().filter((w) => selection.has(w.id));
    remove(
      selected,
      selected.every((w) => w.recommended),
    );
  };
  $("#inspector-button").onclick = () => {
    inspector = !inspector;
    renderInspector();
    renderControls();
  };
  $("#settings-button").onclick = openSettings;
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
    if (state.setupRequired) {
      openSetup();
      return;
    }
    if (action === "refresh") refresh();
    if (action === "settings") openSettings();
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
  $("#settings-stop-scan").onclick = $("#stop-scan").onclick;
  $("#setup-dialog").addEventListener("cancel", (event) =>
    event.preventDefault(),
  );
  $("#setup-dialog").addEventListener("close", () => {
    if (state.setupRequired && !setupSubmitting) openSetup();
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
