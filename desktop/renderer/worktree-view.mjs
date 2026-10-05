import {
  projectTree,
  projectRepositories,
  renderTreeRows,
  renderRepositoryList,
  rowElementID,
} from "./worktree-presentation.mjs";
import { icon, esc, ago, sentenceCase } from "./presentation.mjs";
import { reconcileSelection, selectRow as chooseRow } from "./selection.mjs";

// Owns tree-only interaction state: filters, sorting, expansion and selection.
// Backend revisions reconcile registration IDs; switching workspaces clears it.
export function createWorktreeView({
  document,
  workspace,
  tree,
  showWorktreeMenu,
  onRender = () => {},
}) {
  const $ = (selector) => document.querySelector(selector);
  let view = "all",
    repo = "",
    search = "",
    sort = "path",
    descending = false;
  let selection = { ids: new Set(), anchor: "", cursor: "" };
  let rowSignature = "",
    repoSignature = "",
    directoryRows = [],
    filtered = [],
    visible = [],
    // Where the keyboard cursor last was, for when its row disappears.
    cursorIndex = 0,
    cursorVanished = false;
  const hostFilter = () => workspace.snapshot.hostFilter;
  let previousItems = [],
    previousHost = hostFilter();
  const collapsedDirectories = new Set();
  const items = () => workspace.items;
  const blocked = () => workspace.blocked;
  const selected = () => items().filter((row) => selection.ids.has(row.id));
  // Rendered rows already carry these states. This reapplies them when only
  // the operation changed, without rebuilding the table.
  function renderRowControls() {
    const unavailable = blocked() || !workspace.snapshot.revision;
    const rows = new Map(items().map((row) => [row.id, row]));
    $("#worktree-list")
      .querySelectorAll("[data-delete], [data-folder-delete]")
      .forEach((button) => {
        const row = rows.get(button.dataset.delete);
        button.disabled = unavailable || (!!row && !workspace.canDelete(row));
      });
  }
  const deletable = (row) =>
    workspace.canDelete(row) && (row.canRemove || row.canDiscard);
  // Where the keyboard goes when what it was on is gone: the list while it
  // has rows, otherwise the next thing there is to do.
  function focusList() {
    (visible.length
      ? $("#worktree-grid")
      : $("#empty-state").querySelector?.("button") || $("#refresh-button")
    ).focus({ preventScroll: true });
  }
  function renderSelectionBar() {
    const rows = selected(),
      kept = rows.filter((row) => !deletable(row)).length,
      bar = $("#selection-bar");
    // The bar leaves with the selection. Whoever was using it goes back to
    // the list rather than to nowhere.
    const held = !bar.hidden && !!bar.contains?.(document.activeElement);
    bar.hidden = rows.length < 2;
    if (held && bar.hidden) focusList();
    // Say before the click how much of the selection can actually go.
    $("#selection-label").textContent =
      `${rows.length} worktrees selected${kept ? ` · ${kept} cannot be deleted` : ""}`;
    $("#remove-selected").disabled =
      blocked() || rows.length === kept || !workspace.snapshot.revision;
  }
  function clearSelection() {
    selection = { ids: new Set(), anchor: "", cursor: selection.cursor };
    renderSelection();
    renderSelectionBar();
    onRender();
  }
  // Replacing the rows would drop keyboard focus to the page. Remember the
  // control that held it by what it acts on, not by its element.
  function focusedControl() {
    const element = document.activeElement;
    if (!element?.dataset || !$("#worktree-list").contains(element))
      return null;
    for (const [key, attribute] of [
      ["delete", "data-delete"],
      ["worktreeMenu", "data-worktree-menu"],
      ["folderDelete", "data-folder-delete"],
      ["toggleDirectory", "data-toggle-directory"],
    ])
      if (element.dataset[key] !== undefined)
        return { attribute, value: element.dataset[key] };
    return null;
  }
  function restoreFocus(control) {
    if (!control) return;
    const next = $("#worktree-list").querySelector(
      `[${control.attribute}="${CSS.escape(control.value)}"]`,
    );
    // When its row is gone or unavailable, stay in the list, not on the page.
    (next && !next.disabled ? next : $("#worktree-grid")).focus({
      preventScroll: true,
    });
  }
  function render() {
    const list = items(),
      ready = list.filter((w) => w.recommended),
      repos = projectRepositories(list, workspace.snapshot),
      repositories = new Map(repos.map((entry) => [entry.id, entry]));
    $("#all-count").textContent = list.length;
    $("#recommended-count").textContent = ready.length;
    $("#repo-count").textContent = repos.length;
    const signature = JSON.stringify([repos, repo]);
    if (signature !== repoSignature) {
      $("#repo-list").innerHTML = renderRepositoryList(repos, repo);
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
    renderRows();
  }
  function renderRows() {
    const projection = projectTree(
      items(),
      {
        root: workspace.snapshot.report?.root || workspace.snapshot.root,
        hostFilter: workspace.snapshot.hostFilter,
        hosts: workspace.snapshot.hosts,
        repo,
        view,
        search,
        sort,
        descending,
        collapsedDirectories,
      },
      tree,
    );
    filtered = projection.filtered;
    directoryRows = projection.directoryRows;
    visible = projection.visible;
    // Only a row on screen can be selected or hold the keyboard cursor. No
    // key or button may reach a worktree that a filter or a collapsed folder
    // has hidden.
    const onScreen = new Set(visible.map((row) => row.id));
    const gridFocused = document.activeElement === $("#worktree-grid");
    const lostCursor =
      cursorVanished ||
      (!!selection.cursor && !onScreen.has(selection.cursor));
    cursorVanished = false;
    selection = {
      ids: new Set([...selection.ids].filter((id) => onScreen.has(id))),
      anchor: onScreen.has(selection.anchor) ? selection.anchor : "",
      cursor: onScreen.has(selection.cursor) ? selection.cursor : "",
    };
    // The row under the keyboard went away, deleted or rescanned. The list
    // still has focus, so the cursor moves to the row now in its place; it
    // selects nothing.
    if (lostCursor && gridFocused && visible.length)
      selection.cursor =
        visible[Math.min(cursorIndex, visible.length - 1)].id;
    // A filter shows part of the list, so its count says part of what.
    $("#visible-count").textContent =
      filtered.length === items().length
        ? filtered.length
        : `${filtered.length} of ${items().length}`;
    $("#tree-sort").value = sort;
    $("#sort-direction").innerHTML = icon(
      descending ? "arrow-down" : "arrow-up",
    );
    $("#sort-direction").title = descending
      ? "Descending. Click for ascending."
      : "Ascending. Click for descending.";
    $("#sort-direction").setAttribute(
      "aria-label",
      `Sort ${descending ? "descending" : "ascending"}; switch direction`,
    );
    // An empty list has no row for the keyboard to land on.
    $("#worktree-grid").tabIndex = visible.length ? 0 : -1;
    document.querySelectorAll("[data-sort]").forEach((button) => {
      const active = button.dataset.sort === sort;
      const name = active ? (descending ? "arrow-down" : "arrow-up") : "sort";
      if (button.dataset.sortIcon !== name) {
        button.dataset.sortIcon = name;
        button.querySelector("svg")?.replaceWith(
          document.createRange().createContextualFragment(icon(name)),
        );
      }
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
      workspace.snapshot.busy,
      workspace.connected,
      workspace.removing,
      workspace.snapshot.cancelled,
      workspace.snapshot.revision,
      workspace.snapshot.hostFilter,
      workspace.snapshot.setupRequired,
      workspace.snapshot.error,
      workspace.error,
      filtered.map((w) => ago(w.activityAt)),
    ]);
    if (signature === rowSignature) {
      renderSelection();
      renderRowControls();
      renderSelectionBar();
      onRender();
      return;
    }
    rowSignature = signature;
    // The setup wizard covers a first launch; nothing has been scanned yet,
    // so the list behind it makes no claim about what was found.
    $("#empty-state").hidden =
      filtered.length > 0 || workspace.snapshot.setupRequired;
    if (!filtered.length) $("#empty-state").innerHTML = emptyState();
    const scroll = $("#table-scroll").scrollTop;
    const focus = focusedControl();
    $("#worktree-list").innerHTML = renderTreeRows(directoryRows, {
      selected: selection.ids,
      collapsed: collapsedDirectories,
      disabled: blocked() || !workspace.snapshot.revision,
      canDelete: (row) => workspace.canDelete(row),
      cancelled: workspace.snapshot.cancelled,
    });
    $("#table-scroll").scrollTop = scroll;
    restoreFocus(focus);
    // With no row left to stay on, the keyboard goes to what can be done next.
    if (gridFocused && !visible.length) focusList();
    renderActiveRow();
    renderSelectionBar();
    onRender();
  }
  // Focus stays on the grid while arrow keys move through it. Name the row
  // the cursor is on so assistive technology can follow.
  function renderActiveRow() {
    const grid = $("#worktree-grid");
    const index = visible.findIndex((row) => row.id === selection.cursor);
    if (index >= 0) cursorIndex = index;
    const active =
      selection.cursor &&
      document.getElementById(rowElementID(selection.cursor));
    document
      .querySelectorAll(".worktree-row.is-current")
      .forEach((row) => row.classList.remove("is-current"));
    if (active) {
      active.classList.add("is-current");
      grid.setAttribute("aria-activedescendant", active.id);
    } else grid.removeAttribute("aria-activedescendant");
  }
  // Why the list is empty decides what to say and what to offer next.
  function emptyState() {
    const action = (attribute, label) =>
      `<button class="button" ${attribute}>${label}</button>`;
    const message = (name, spin, heading, description, actions = "") =>
      `${icon(name, spin ? "spinning" : "")}<h2>${heading}</h2><p>${description}</p>${actions ? `<div class="empty-actions">${actions}</div>` : ""}`;
    if (workspace.snapshot.busy || (!workspace.connected && !workspace.error))
      return message(
        "refresh",
        true,
        "Finding linked worktrees…",
        "Worktree folders appear here as they are discovered.",
      );
    if (items().length && !search.trim() && !repo)
      return message(
        "check-circle",
        false,
        "Nothing to clean up",
        "Clean worktrees whose commits are already merged will appear here.",
      );
    if (items().length)
      return message(
        "search",
        false,
        search.trim()
          ? `No worktrees match “${esc(search.trim())}”`
          : "No worktrees in this repository",
        "Try a different search, or clear the filter to see everything.",
        action("data-clear-filter", "Clear filter"),
      );
    // A scan that failed found nothing; it did not find that there is nothing.
    // The reason is repeated here because the banner above can be dismissed.
    const failure = workspace.snapshot.error || workspace.error;
    if (failure)
      return message(
        "warning",
        false,
        "This scan did not finish",
        sentenceCase(failure).split("\n").slice(0, 3).map(esc).join("<br />"),
        action("data-scan-again", "Scan again") +
          action("data-open-settings", "Scan settings…"),
      );
    if (workspace.snapshot.cancelled)
      return message(
        "warning",
        false,
        "Scan stopped before it finished",
        "Nothing had been found yet. Scan again to look through the whole folder.",
        action("data-scan-again", "Scan again"),
      );
    return message(
      "folder",
      false,
      "No linked worktrees here",
      "Arbor lists worktrees created with <code>git worktree add</code>. Ordinary repository checkouts are not included.",
      action("data-choose-folder", "Choose another folder…"),
    );
  }
  function renderSelection() {
    document.querySelectorAll(".worktree-row").forEach((row) => {
      row.classList.toggle("selected", selection.ids.has(row.dataset.id));
      row.setAttribute(
        "aria-selected",
        String(selection.ids.has(row.dataset.id)),
      );
    });
    renderActiveRow();
  }
  function selectRow(id, event) {
    selection = chooseRow(selection, visible, id, event);
    renderSelection();
    renderSelectionBar();
    // The status bar explains a lone selection, so it follows each change.
    onRender();
    $("#worktree-grid").focus({ preventScroll: true });
  }
  function handleTreeClick(event) {
    const button = event.target.closest("button");
    if (button) {
      if (button.disabled) return;
      if (button.dataset.view) {
        view = button.dataset.view;
        repo = "";
        selection.ids.clear();
        render();
      }
      if (button.dataset.repo !== undefined) {
        repo = repo === button.dataset.repo ? "" : button.dataset.repo;
        view = "all";
        selection.ids.clear();
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
        workspace.deleteWorktrees(
          tree.folderWorktrees(directoryRows, button.dataset.folderDelete),
        );
      if (button.dataset.delete) {
        const w = items().find((w) => w.id === button.dataset.delete);
        if (w) workspace.deleteWorktrees([w]);
      }
      if (button.dataset.worktreeMenu)
        showWorktreeMenu(button.dataset.worktreeMenu);
      return;
    }
    const row = event.target.closest("[data-id]");
    if (row) selectRow(row.dataset.id, event);
  }
  [".views", "#repo-list", "#table-scroll"].forEach((selector) =>
    $(selector).addEventListener("click", handleTreeClick),
  );
  $("#worktree-list").addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    event.preventDefault();
    if (!selection.ids.has(row.dataset.id)) selectRow(row.dataset.id, event);
    showWorktreeMenu(row.dataset.id);
  });
  // Tabbing into the list lands on a row, as in any list: the first selected
  // one, or the first row. It moves the cursor without changing the selection.
  $("#worktree-grid").addEventListener("focus", () => {
    if (selection.cursor || !visible.length) return;
    const current =
      visible.find((row) => selection.ids.has(row.id)) || visible[0];
    selection = { ...selection, cursor: current.id };
    renderActiveRow();
  });
  $("#empty-state").addEventListener("click", (event) => {
    if (event.target.closest("[data-clear-filter]")) {
      repo = "";
      $("#search").value = "";
      setSearch("");
      render();
      $("#search").focus();
    }
    if (event.target.closest("[data-scan-again]")) workspace.refresh();
  });
  $("#worktree-grid").addEventListener("keydown", (event) => {
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
    // Escape clears the selection from anywhere in the list, a row's own
    // buttons included.
    if (event.key === "Escape" && selection.ids.size) {
      event.preventDefault();
      clearSelection();
      $("#worktree-grid").focus({ preventScroll: true });
      return;
    }
    if (event.target.closest("button")) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!visible.length) return;
      let index = visible.findIndex((w) => w.id === selection.cursor);
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
      if (selection.cursor) showWorktreeMenu(selection.cursor);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "a") {
      event.preventDefault();
      selection.ids = new Set(visible.map((w) => w.id));
      render();
    }
    // Deletion always asks first, so the key is as safe as the button.
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      workspace.deleteWorktrees(selected());
    }
  });
  // A search opens every folder so its matches show. That is a view of the
  // search, not a change to how the tree was arranged, so the arrangement
  // comes back when the search is cleared.
  let collapsedBeforeSearch = null;
  function setSearch(value) {
    if (search === value) return;
    if (!search.trim() && value.trim()) {
      collapsedBeforeSearch = new Set(collapsedDirectories);
      collapsedDirectories.clear();
    } else if (search.trim() && !value.trim() && collapsedBeforeSearch) {
      collapsedDirectories.clear();
      collapsedBeforeSearch.forEach((key) => collapsedDirectories.add(key));
      collapsedBeforeSearch = null;
    }
    search = value;
    selection.ids.clear();
    render();
  }
  $("#search").oninput = (event) => setSearch(event.target.value);
  $("#tree-sort").onchange = (event) => {
    sort = event.target.value;
    descending = ["activity", "size"].includes(sort);
    renderRows();
  };
  $("#sort-direction").onclick = () => {
    descending = !descending;
    renderRows();
  };
  $("#clear-selection").onclick = clearSelection;
  $("#selection-bar").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    clearSelection();
  });

  $("#remove-selected").onclick = () => workspace.deleteWorktrees(selected());
  function resetView(full = false) {
    view = "all";
    repo = "";
    selection = { ids: new Set(), anchor: "", cursor: "" };
    if (full) {
      search = "";
      sort = "path";
      descending = false;
      collapsedDirectories.clear();
      collapsedBeforeSearch = null;
      $("#search").value = "";
    }
  }
  return {
    reset: resetView,
    render() {
      const next = items();
      const cursor = selection.cursor;
      selection = reconcileSelection(
        previousItems,
        next,
        selection,
        previousHost === hostFilter(),
      );
      // Reconciling drops a cursor whose worktree is gone from the report.
      cursorVanished = !!cursor && !selection.cursor;
      previousItems = next;
      previousHost = hostFilter();
      render();
    },
    focusSearch() {
      $("#search").focus();
      $("#search").select();
    },
    // What the list currently shows after the view, repository, and search
    // filters, including rows inside collapsed folders.
    get filtered() {
      return filtered;
    },
    get filtering() {
      return !!repo || !!search.trim();
    },
    get selectedCount() {
      return selection.ids.size;
    },
  };
}
