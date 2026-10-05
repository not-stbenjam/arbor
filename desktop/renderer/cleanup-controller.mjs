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

// A name is shown as it is, but never invisibly: a character that would hide
// or reorder the text around it is drawn as a mark instead, and the name
// keeps its own direction whatever script it is written in.
const plain = (value) =>
  String(value ?? "").replace(
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    "\ufffd",
  );
const named = (value) => `<bdi>${esc(plain(value))}</bdi>`;
// A path too long for its line breaks between folders. A folder's own name
// is split only when it is longer than a line.
const pathed = (value) =>
  `<bdi>${plain(value)
    .match(/[^/]*\/?/g)
    .filter(Boolean)
    .map((part) => `<span class="path-part">${esc(part)}</span>`)
    .join("")}</bdi>`;

// Everything the review says about a worktree. One that no longer matches
// what was read is a different worktree to agree to.
const described = (row) =>
  JSON.stringify([
    row.host || "",
    row.path,
    row.head,
    branchName(row),
    row.repo || "",
    recommendationReason(row),
  ]);

// Delete recommended deletes nothing by itself. It opens this review: every
// worktree it would delete and why each is one Arbor recommends, with the
// decision left to a second button.
//
// The list is the one that was read. It is not redrawn while it is open, so
// nothing can appear under the pointer on its way to Delete. A worktree that
// has changed since is marked, and kept from then on even if it changes back,
// and one that has since become a recommendation waits for the next time:
// agreeing can come to cover less than was shown, never more.
export function createCleanupController({
  document,
  workspace,
  shown,
  onDeleting = () => {},
}) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#cleanup-dialog");
  // The rows as they were when the review opened, those since kept, whether
  // deleting has had to wait, and what was last said aloud about it all.
  let reviewed = [],
    kept = new Set(),
    waited = false,
    said = "";
  const hostLabel = (row) =>
    workspace.snapshot.hosts.find((source) => source.host === (row.host || ""))
      ?.label ||
    row.host ||
    "This computer";
  // The reviewed rows that are still what the review says they are, as they
  // are now. Looking is what finds one changed, and it stays kept.
  function standing() {
    const current = new Map(
      recommendedShown(shown).map((row) => [row.id, row]),
    );
    return reviewed.flatMap((row) => {
      const now = current.get(row.id);
      if (!now || described(now) !== described(row)) kept.add(row.id);
      return kept.has(row.id) ? [] : [now];
    });
  }
  // Another operation can hold a worktree for a moment without changing it.
  // Nothing is deleted meanwhile, and nothing is struck from the list.
  const available = (rows) =>
    !workspace.blocked && rows.every((row) => workspace.canDelete(row));
  function renderList() {
    const everyHost = workspace.snapshot.hostFilter === null;
    $("#cleanup-list").innerHTML = reviewed
      .map((row) => {
        const name = row.path.split("/").filter(Boolean).pop() || row.path;
        const context = [branchName(row), row.repo, everyHost && hostLabel(row)]
          .filter(Boolean)
          .map(named)
          .join(" · ");
        return `<li class="cleanup-item" data-review="${esc(row.id)}">${icon("branch")}<span class="cleanup-name">${named(name)}</span><span class="cleanup-size">${size(row.sizeBytes)}</span><span class="cleanup-kept">Kept</span><span class="cleanup-context">${context}</span><span class="cleanup-reason">${named(recommendationReason(row))}</span><span class="cleanup-changed">Changed since you opened this list, so it is kept.</span><span class="cleanup-path">${pathed(row.path)}</span></li>`;
      })
      .join("");
  }
  function render() {
    if (!dialog.open) return;
    const rows = standing(),
      count = plural(rows.length, "worktree"),
      ready = available(rows);
    $("#cleanup-title").textContent = !rows.length
      ? reviewed.length === 1
        ? "This worktree has changed"
        : "These worktrees have changed"
      : reviewed.length === 1
        ? "Delete this recommended worktree?"
        : `Delete ${kept.size ? `${rows.length} of these` : "these"} ${reviewed.length} recommended worktrees?`;
    $("#cleanup-list")
      .querySelectorAll("[data-review]")
      .forEach((item) =>
        item.classList.toggle("changed", kept.has(item.dataset.review)),
      );
    const scope = shown().filtering
      ? "Only what the list is showing"
      : workspace.snapshot.hostFilter === null
        ? "All hosts"
        : workspace.snapshot.host || "This computer";
    const waiting = rows.length > 0 && !ready;
    waited ||= waiting;
    // An operation on a worktree's host ends by itself. Anything else that
    // stops a deletion, such as a lost connection, may not.
    $("#cleanup-total").textContent = !rows.length
      ? "Close this list and open it again to see what is recommended now."
      : !waiting
        ? `About ${size(sizeOf(rows))} to recover · ${scope}`
        : workspace.blocked
          ? "Deleting is unavailable for now."
          : "Deleting is unavailable until the current operation finishes.";
    const confirm = $("#cleanup-confirm");
    confirm.textContent = rows.length ? `Delete ${count}` : "Delete";
    // A disabled button cannot hold the keyboard. It goes to the answer
    // that is still there.
    if ((waiting || !rows.length) && document.activeElement === confirm)
      $("#cleanup-cancel").focus();
    confirm.disabled = waiting || !rows.length;
    // Said aloud once each time the answer on offer changes. Whoever is on
    // Cancel cannot see a row further up being marked, or Delete go grey.
    const saying = [
      kept.size
        ? `${plural(kept.size, "worktree")} changed and ${kept.size === 1 ? "is" : "are"} kept. ${rows.length ? `${count} would be deleted.` : "Nothing would be deleted."}`
        : "",
      waiting
        ? "Deleting is unavailable for now."
        : waited && rows.length
          ? "Deleting is available again."
          : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (saying !== said) $("#cleanup-status").textContent = said = saying;
  }
  function open() {
    if (dialog.open || workspace.blocked || !workspace.snapshot.revision)
      return;
    reviewed = recommendedShown(shown);
    if (!reviewed.length) return;
    kept = new Set();
    waited = false;
    $("#cleanup-status").textContent = said = "";
    renderList();
    dialog.showModal();
    // It opens at its beginning. Where there is so little room that the
    // buttons are out of sight below the list, the keyboard starts at the
    // heading with it, not on a Cancel that cannot be seen.
    dialog.scrollTop = $("#cleanup-body").scrollTop = 0;
    if (dialog.scrollHeight > dialog.clientHeight)
      $("#cleanup-title").focus({ preventScroll: true });
    render();
  }
  $("#cleanup-cancel").onclick = () => dialog.close();
  $("#cleanup-confirm").onclick = () => {
    const rows = standing();
    if (!rows.length || !available(rows)) return;
    dialog.close();
    const deleting = workspace.remove(rows, true);
    // Closing hands the keyboard back to the button that opened the review,
    // which a deletion disables.
    onDeleting();
    return deleting;
  };
  // A held Enter repeats the press. The one that opened the review must not
  // go on to answer it.
  dialog.addEventListener("keydown", (event) => {
    if (event.repeat && event.key === "Enter") event.preventDefault();
  });
  return { open, render };
}
