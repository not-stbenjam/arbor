import {
  projectTree,
  projectRepositories,
  renderTreeRows,
  renderRepositoryList,
  rowElementID,
} from "./worktree-presentation.mjs";
import { icon, ago } from "./presentation.mjs";
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
    visible = [];
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
  function renderSelectionBar() {
    $("#selection-bar").hidden = selection.ids.size < 2;
    $("#selection-label").textContent =
      `${selection.ids.size} worktrees selected`;
    $("#remove-selected").disabled =
      blocked() || !selection.ids.size || !workspace.snapshot.revision;
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
      workspace.snapshot.busy,
      workspace.connected,
      workspace.removing,
      workspace.snapshot.cancelled,
      workspace.snapshot.revision,
      workspace.snapshot.hostFilter,
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
    $("#empty-state").hidden = filtered.length > 0;
    if (!filtered.length) {
      const loading =
        workspace.snapshot.busy || (!workspace.connected && !workspace.error);
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
    renderActiveRow();
    renderSelectionBar();
    onRender();
  }
  // Focus stays on the grid while arrow keys move through it. Name the row
  // the cursor is on so assistive technology can follow.
  function renderActiveRow() {
    const grid = $("#worktree-grid");
    const active =
      selection.cursor &&
      document.getElementById(rowElementID(selection.cursor));
    if (active) grid.setAttribute("aria-activedescendant", active.id);
    else grid.removeAttribute("aria-activedescendant");
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
  $("#search").oninput = (event) => {
    if (search !== event.target.value) collapsedDirectories.clear();
    search = event.target.value;
    selection.ids.clear();
    render();
  };
  $("#tree-sort").onchange = (event) => {
    sort = event.target.value;
    descending = ["activity", "size"].includes(sort);
    renderRows();
  };

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
      $("#search").value = "";
    }
  }
  return {
    reset: resetView,
    render() {
      const next = items();
      selection = reconcileSelection(
        previousItems,
        next,
        selection,
        previousHost === hostFilter(),
      );
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
  };
}
