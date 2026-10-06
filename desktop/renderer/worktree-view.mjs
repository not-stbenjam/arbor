import {
  projectTree,
  projectRepositories,
  renderTreeRows,
  renderRepositoryList,
  rowElementID,
} from "./worktree-presentation.mjs";
import { icon, esc, ago, sentenceCase } from "./presentation.mjs";
import { reconcileSelection, selectRow as chooseRow } from "./selection.mjs";
import { lossesOf } from "../common/losses.mjs";

// Owns tree-only interaction state: filters, sorting, expansion and selection.
// Backend revisions reconcile registration IDs; switching workspaces clears it.
export function createWorktreeView({
  document,
  workspace,
  tree,
  showWorktreeMenu,
  onRender = () => {},
  // Shows several worktrees chosen for deletion, each with what deleting it
  // means, before anything is asked.
  reviewDeletion = (rows) => workspace.deleteWorktrees(rows),
}) {
  const $ = (selector) => document.querySelector(selector);
  let view = "all",
    repo = "",
    search = "",
    sort = "path",
    descending = false;
  let selection = { ids: new Set(), cursor: "" };
  const rowElements = new Map();
  let rowSignature = "",
    emptyMarkup = null,
    repoSignature = "",
    directoryRows = [],
    filtered = [],
    visible = [],
    // Where the keyboard cursor last was, for when its row disappears.
    cursorIndex = 0,
    cursorVanished = false,
    folderRows = new Map();
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
        button.disabled =
          unavailable ||
          (!!row && (!workspace.canDelete(row) || (!row.pending && !deletable(row))));
      });
  }
  // Whether a row could ever be deleted, as distinct from whether anything
  // can be deleted this instant: a scan or another deletion only postpones it.
  function deletable(row) {
    return !row.pending && (row.canRemove || row.canDiscard);
  }
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
    bar.hidden = rows.length === 0;
    if (held && bar.hidden) focusList();
    // Say before the click how much of the selection can actually go.
    // ...and how much of it is not a clean delete, which the confirmation
    // then spells out.
    const unclean = rows.filter(
      (row) => deletable(row) && lossesOf(row).length,
    ).length;
    // A tick outlasts a search or a closed folder that takes its row out
    // of the list, so the bar says how many of them cannot be seen.
    const inList = new Set(visible.map((row) => row.id)),
      unseen = rows.filter((row) => !inList.has(row.id)).length;
    $("#selection-label").textContent =
      `${rows.length} ${rows.length === 1 ? "worktree" : "worktrees"} selected${unseen ? ` · ${unseen} not shown` : ""}${unclean ? ` · ${unclean} not clean` : ""}${kept ? ` · ${kept} cannot be deleted` : ""}`;
    $("#remove-selected").disabled =
      blocked() ||
      !workspace.snapshot.revision ||
      !rows.some((row) => deletable(row) && workspace.canDelete(row));
  }
  function clearSelection() {
    selection = { ids: new Set(), cursor: selection.cursor };
    selectionChanged();
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
      ["selectFolder", "data-select-folder"],
      ["select", "data-select"],
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
    if (next && !next.disabled && !next.hidden)
      next.focus({ preventScroll: true });
    else focusList();
  }
  function render() {
    const list = items(),
      ready = list.filter((w) => w.recommended),
      repos = projectRepositories(list, workspace.snapshot),
      repositories = new Map(repos.map((entry) => [entry.id, entry]));
    $("#all-count").textContent = list.length;
    $("#recommended-count").textContent = ready.length;
    // Green is what Delete recommended would delete: here, how many there
    // are, as on each of their rows.
    $("#recommended-count").classList.toggle("ready", ready.length > 0);
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
    // What each folder's box ticks: the rows shown under it, in any open
    // folder beneath. A closed folder shows none, so its box has nothing to do.
    const shown = new Set(visible.map((row) => row.id));
    folderRows = new Map(
      directoryRows
        .filter((entry) => entry.kind !== "worktree")
        .map((entry) => [
          entry.kind === "host"
            ? entry.key
            : entry.node.key || entry.node.path,
          (entry.kind === "host" ? entry.descendants : entry.node.descendants)
            .filter((row) => shown.has(row.id))
            .map((row) => row.id),
        ]),
    );
    // Only a row on screen can hold the keyboard cursor. A tick is kept
    // when a search or a closed folder takes its row out of the list, so a
    // selection can be gathered over several searches; the selection bar
    // counts what is not shown, and deleting several shows every one first.
    const onScreen = new Set(visible.map((row) => row.id));
    const known = new Set(items().map((row) => row.id));
    const gridFocused = document.activeElement === $("#worktree-grid");
    const lostCursor =
      cursorVanished ||
      (!!selection.cursor && !onScreen.has(selection.cursor));
    cursorVanished = false;
    selection = {
      ids: new Set([...selection.ids].filter((id) => known.has(id))),
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
    // Written only when it changes: whoever is on one of its buttons would
    // otherwise be left on nothing each time the list is drawn again.
    const empty = filtered.length ? "" : emptyState();
    if (empty !== emptyMarkup) {
      const held = !!$("#empty-state").contains?.(document.activeElement);
      $("#empty-state").innerHTML = emptyMarkup = empty;
      if (held && !filtered.length) focusList();
    }
    const scroll = $("#table-scroll").scrollTop;
    const focus = focusedControl();
    const options = {
      selected: selection.ids,
      collapsed: collapsedDirectories,
      disabled: blocked() || !workspace.snapshot.revision,
      canDelete: (row) => workspace.canDelete(row),
      cancelled: workspace.snapshot.cancelled,
    };
    const list = $("#worktree-list");
    const rows = directoryRows.map((entry) => ({
      key: JSON.stringify(
        entry.kind === "worktree"
          ? [entry.kind, entry.worktree.id]
          : [entry.kind, entry.kind === "host" ? entry.key : entry.node.key || entry.node.path],
      ),
      id: entry.kind === "worktree" ? entry.worktree.id : "",
      markup: renderTreeRows([entry], options),
    }));
    if (!rowElements.size) {
      list.innerHTML = rows.map((row) => row.markup).join("");
      list.querySelectorAll("tr").forEach((element, index) => {
        rowElements.set(rows[index].key, { ...rows[index], element });
      });
    } else {
      const range = document.createRange();
      range.selectNodeContents(list);
      const wanted = new Set(rows.map((row) => row.key));
      for (const [key, row] of rowElements) {
        if (!wanted.has(key)) row.element.remove();
        // Keep filtered-out worktrees for clearing the search, but release
        // registrations that have left the report and unused folder rows.
        if (!wanted.has(key) && (!row.id || !known.has(row.id)))
          rowElements.delete(key);
      }
      let before = list.firstChild;
      for (const row of rows) {
        let cached = rowElements.get(row.key);
        if (!cached || cached.markup !== row.markup) {
          const element = range.createContextualFragment(row.markup).firstChild;
          if (cached?.element === before) before = before.nextSibling;
          cached?.element.remove();
          cached = { ...row, element };
          rowElements.set(row.key, cached);
        }
        // Reordering an existing row preserves its layout and its controls.
        // Rows that stay in place need no DOM mutation at all.
        if (cached.element !== before) {
          if (cached.element.parentNode === list)
            list.moveBefore(cached.element, before);
          else list.insertBefore(cached.element, before);
        } else before = before.nextSibling;
      }
    }
    $("#table-scroll").scrollTop = scroll;
    renderSelection();
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
    // The one failure with an obvious way out: the folder to scan on this
    // computer has gone, and another can be chosen.
    const failed = (workspace.snapshot.hosts || []).filter((source) => source.error);
    const gone =
      failed.length === 1 &&
      !failed[0].host &&
      /^folder does not exist: (.+)$/.exec(failed[0].error);
    if (gone)
      return message(
        "folder",
        false,
        "The folder to scan is not there",
        `<span class="empty-path">${esc(gone[1])}</span> does not exist on this computer. Choose another folder, or scan again once it is back.`,
        action("data-choose-folder", "Choose another folder…") +
          action("data-scan-again", "Scan again"),
      );
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
    // The boxes are the selection, drawn: a row's is ticked when it is
    // selected, and a folder's or the heading's when every row shown under
    // it is. With only some of them ticked it stays empty. A dash there would
    // be a mark on every folder above a row for each tick made in it.
    const tick = (box, ids) => {
      box.checked = ids.length > 0 && ids.every((id) => selection.ids.has(id));
      box.hidden = ids.length === 0;
    };
    document
      .querySelectorAll("[data-select]")
      .forEach((box) => (box.checked = selection.ids.has(box.dataset.select)));
    document
      .querySelectorAll("[data-select-folder]")
      .forEach((box) =>
        tick(box, folderRows.get(box.dataset.selectFolder) || []),
      );
    const all = $("#select-all"),
      held = document.activeElement === all;
    tick(
      all,
      visible.map((row) => row.id),
    );
    // The heading's box goes when the last row does. The keyboard does not
    // go with it.
    if (held && all.hidden) focusList();
    renderActiveRow();
  }
  // Ticking is always additive: a box never clears what is already ticked.
  function tickRows(ids) {
    const every = ids.every((id) => selection.ids.has(id));
    const next = new Set(selection.ids);
    ids.forEach((id) => (every ? next.delete(id) : next.add(id)));
    selection = { ...selection, ids: next };
    selectionChanged();
  }
  function selectionChanged() {
    renderSelection();
    renderSelectionBar();
    // The status bar explains a lone selection, so it follows each change.
    onRender();
  }
  // Where the pointer last went down in the list. A click that ends more than
  // a few pixels from there was a drag. A click made without a pointer, by a
  // key or by assistive technology, has no press to measure from.
  let pressed = null;
  const dragged = (event) =>
    event.detail > 0 &&
    !!pressed &&
    Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4;
  // One worktree in plain view is asked about by name. Several, or one a
  // search or a closed folder has taken out of the list, are shown in full
  // first: nothing is deleted that was not in front of whoever agreed to it.
  function deleteRows(rows) {
    const inList = new Set(visible.map((row) => row.id));
    if (rows.length === 1 && inList.has(rows[0].id))
      return workspace.deleteWorktrees(rows);
    if (rows.length) reviewDeletion(rows);
  }
  function selectRow(id, how) {
    selection = chooseRow(selection, visible, id, how);
    selectionChanged();
    $("#worktree-grid").focus({ preventScroll: true });
  }
  function handleTreeClick(event) {
    // A box, or the cell around it, ticks without disturbing the rest, and
    // Shift takes a range.
    const cell = event.target.closest(".check-cell, .check-column");
    const box = cell?.querySelector("input");
    if (box) {
      if (box.dataset.select)
        selectRow(box.dataset.select, { tick: true, range: event.shiftKey });
      else if (box.dataset.selectFolder)
        tickRows(folderRows.get(box.dataset.selectFolder) || []);
      else tickRows(visible.map((row) => row.id));
      return;
    }
    const button = event.target.closest("button");
    if (button) {
      if (button.disabled) return;
      if (button.dataset.view) {
        view = button.dataset.view;
        repo = "";
        render();
      }
      if (button.dataset.repo !== undefined) {
        repo = repo === button.dataset.repo ? "" : button.dataset.repo;
        view = "all";
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
        deleteRows(
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
    // The whole row is its box: a click anywhere on it ticks or unticks it.
    // Dragging across its text selects the text, to copy, and ticks nothing.
    const row = event.target.closest("[data-id]");
    if (row && !dragged(event))
      selectRow(row.dataset.id, { tick: true, range: event.shiftKey });
  }
  [".views", "#repo-list", "#table-scroll"].forEach((selector) =>
    $(selector).addEventListener("click", handleTreeClick),
  );
  $("#worktree-list").addEventListener("mousedown", (event) => {
    pressed = { x: event.clientX, y: event.clientY };
    // Shift with a click takes a range of rows. Left alone, the browser would
    // also select the text between the two clicks. A row's own buttons and
    // box keep their press, and the focus that comes with it.
    if (
      event.shiftKey &&
      event.button === 0 &&
      event.target.closest("[data-id]") &&
      !event.target.closest("button, input")
    )
      event.preventDefault();
  });
  $("#worktree-list").addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-id]");
    if (!row) return;
    event.preventDefault();
    // The menu is for the row it was opened on; the cursor goes there too,
    // and nothing is ticked by it.
    selectRow(row.dataset.id);
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
    // On a box, Space is the box's own; Delete still means what is ticked.
    if (
      event.target.closest("input") &&
      !["Delete", "Backspace"].includes(event.key)
    )
      return;
    // Space ticks the row the cursor is on, as clicking it does. A key held
    // down is one press, not a tick and an untick and a tick.
    if (event.key === " ") {
      event.preventDefault();
      if (!event.repeat && selection.cursor)
        selectRow(selection.cursor, { tick: true });
      return;
    }
    if (
      ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(
        event.key,
      )
    ) {
      event.preventDefault();
      if (!visible.length) return;
      let index = visible.findIndex((w) => w.id === selection.cursor);
      // A page is as many rows as the list shows, less one to keep the place.
      const height = document.querySelector(".worktree-row")?.offsetHeight || 1;
      const page = Math.max(
        1,
        Math.floor($("#table-scroll").clientHeight / height) - 1,
      );
      const step = {
        ArrowDown: 1,
        ArrowUp: -1,
        PageDown: page,
        PageUp: -page,
      }[event.key];
      index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? visible.length - 1
            : index < 0
              ? 0
              : Math.max(0, Math.min(visible.length - 1, index + step));
      // Only Shift changes what is ticked on the way; Ctrl or Cmd with an
      // arrow key is the system's or nobody's, not a tick.
      selectRow(visible[index].id, { range: event.shiftKey });
      // A page key turns the page: the row it lands on leads the next one.
      document
        .querySelector(
          `.worktree-row[data-id="${CSS.escape(visible[index].id)}"]`,
        )
        ?.scrollIntoView({
          block:
            event.key === "PageDown"
              ? "start"
              : event.key === "PageUp"
                ? "end"
                : "nearest",
        });
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
      // Everything the list shows, added to whatever is already ticked.
      selection.ids = new Set([...selection.ids, ...visible.map((w) => w.id)]);
      render();
    }
    // Deletion always asks first, so the key is as safe as the button. It
    // takes what is ticked, or with nothing ticked, the row the cursor is on.
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const ticked = selected();
      deleteRows(
        ticked.length
          ? ticked
          : visible.filter((row) => row.id === selection.cursor),
      );
    }
  });
  // A search opens every folder so its matches show. That is a view of the
  // search, not a change to how the tree was arranged, so the arrangement
  // comes back when the search is cleared.
  let collapsedBeforeSearch = null,
    searchSaid = 0;
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
    render();
    // Said once typing pauses, not for each letter.
    clearTimeout(searchSaid);
    searchSaid = setTimeout(() => {
      const count = visible.length,
        text = search.trim();
      $("#announcement").textContent = !text
        ? `Filter cleared. ${count} ${count === 1 ? "worktree" : "worktrees"} shown.`
        : count
          ? `${count} ${count === 1 ? "worktree matches" : "worktrees match"} “${text}”.`
          : `No worktrees match “${text}”.`;
    }, 400);
  }
  $("#search").oninput = (event) => setSearch(event.target.value);
  // From the search, Down goes straight to what it found: the list takes the
  // keyboard, on its first row. Tab still visits the controls in between.
  $("#search").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" || !visible.length) return;
    event.preventDefault();
    selection = { ...selection, cursor: visible[0].id };
    $("#worktree-grid").focus({ preventScroll: true });
    renderActiveRow();
    $("#table-scroll").scrollTop = 0;
  });
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

  $("#remove-selected").onclick = () => deleteRows(selected());
  function resetView(full = false) {
    view = "all";
    repo = "";
    selection = { ids: new Set(), cursor: "" };
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
    // Puts the keyboard in the list, or on what there is to do when the
    // list is empty.
    focus: focusList,
    // The list itself, rows or none: where the keyboard belongs once setup
    // has started the first scan and there is nothing yet to stand on.
    focusGrid: () => $("#worktree-grid").focus({ preventScroll: true }),
    // What the list currently shows after the view, repository, and search
    // filters, including rows inside collapsed folders.
    get filtered() {
      return filtered;
    },
    // The rows the list is drawing now: those, less any in closed folders.
    get visible() {
      return visible;
    },
    get filtering() {
      return !!repo || !!search.trim();
    },
    get selectedCount() {
      return selection.ids.size;
    },
  };
}
