import { icon, esc, branchName, size, sizeOf } from "./presentation.mjs";
import { recommendationReason } from "./worktree-presentation.mjs";

const plural = (count, noun) => `${count} ${count === 1 ? noun : `${noun}s`}`;

// What Delete recommended acts on: the recommendations the list currently
// shows. Repository and search filters narrow it, as they narrow the list.
export const recommendedShown = (shown) =>
  shown().filtered.filter((row) => row.recommended);

// Where those are, in the words used wherever the action is described.
export const cleanupScope = (workspace, shown) =>
  shown().filtering
    ? "shown in this view"
    : `on ${
        workspace.snapshot.hostFilter === null
          ? "all hosts"
          : workspace.snapshot.host || "this computer"
      }`;

// Delete recommended deletes nothing by itself. It opens this review: every
// worktree it would delete and why each is one Arbor recommends, with the
// decision left to a second button.
//
// The list is the one that was read. It is not redrawn while it is open, so
// nothing can appear under the pointer on its way to Delete. A worktree that
// has changed since is marked and left alone, and one that has since become a
// recommendation waits for the next time: agreeing can come to cover less
// than was shown, never more.
export function createCleanupController({ document, workspace, shown }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#cleanup-dialog");
  // The rows as they were when the review opened.
  let reviewed = [];
  const hostLabel = (row) =>
    workspace.snapshot.hosts.find((source) => source.host === (row.host || ""))
      ?.label ||
    row.host ||
    "This computer";
  // The reviewed rows that are still the same recommendation, as they are now.
  function standing() {
    const current = new Map(
      recommendedShown(shown).map((row) => [row.id, row]),
    );
    return reviewed
      .map((row) => current.get(row.id))
      .filter(
        (row, index) =>
          row && row.head === reviewed[index].head && workspace.canDelete(row),
      );
  }
  function renderList() {
    const everyHost = workspace.snapshot.hostFilter === null;
    $("#cleanup-list").innerHTML = reviewed
      .map((row) => {
        const name = row.path.split("/").filter(Boolean).pop() || row.path;
        const context = [branchName(row), row.repo, everyHost && hostLabel(row)]
          .filter(Boolean)
          .map(esc)
          .join(" · ");
        return `<li class="cleanup-item" data-review="${esc(row.id)}">${icon("branch")}<div class="cleanup-copy"><span class="cleanup-name" title="${esc(row.path)}">${esc(name)}</span><span class="cleanup-context">${context}</span><span class="cleanup-reason">${esc(recommendationReason(row))}</span><span class="cleanup-changed">Changed since this list was made. It will be left alone.</span></div><span class="cleanup-size">${size(row.sizeBytes)}</span></li>`;
      })
      .join("");
  }
  function render() {
    if (!dialog.open) return;
    const rows = standing(),
      kept = new Set(rows.map((row) => row.id)),
      count = plural(rows.length, "worktree");
    $("#cleanup-title").textContent = !rows.length
      ? "These worktrees have changed"
      : reviewed.length === 1
        ? "Delete this recommended worktree?"
        : `Delete ${rows.length === reviewed.length ? "these" : `${rows.length} of these`} ${reviewed.length} recommended worktrees?`;
    $("#cleanup-list")
      .querySelectorAll("[data-review]")
      .forEach((item) =>
        item.classList.toggle("changed", !kept.has(item.dataset.review)),
      );
    $("#cleanup-total").textContent =
      `${count} ${cleanupScope(workspace, shown)} · about ${size(sizeOf(rows))}`;
    const confirm = $("#cleanup-confirm");
    confirm.textContent = `Delete ${count}`;
    confirm.disabled = workspace.blocked || !rows.length;
  }
  function open() {
    if (dialog.open || workspace.blocked || !workspace.snapshot.revision)
      return;
    reviewed = recommendedShown(shown);
    if (!reviewed.length) return;
    renderList();
    dialog.showModal();
    $("#cleanup-list").scrollTop = 0;
    render();
  }
  $("#cleanup-cancel").onclick = () => dialog.close();
  $("#cleanup-confirm").onclick = () => {
    const rows = standing();
    if (workspace.blocked || !rows.length) return;
    dialog.close();
    return workspace.remove(rows, true);
  };
  // A held Enter repeats the press. The one that opened the review must not
  // go on to answer it.
  dialog.addEventListener("keydown", (event) => {
    if (event.repeat && event.key === "Enter") event.preventDefault();
  });
  return { open, render };
}
