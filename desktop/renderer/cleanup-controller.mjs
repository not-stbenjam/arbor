import { icon, esc, plain, branchName, size, sizeOf } from "./presentation.mjs";
import { recommendationReason } from "./worktree-presentation.mjs";
import { LOSSES, lossesOf } from "../common/losses.mjs";

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
const named = (value) => `<bdi>${esc(plain(value))}</bdi>`;
// A path too long for its line breaks between folders. A folder's own name
// is split only when it is longer than a line.
const pathed = (value) =>
  `<bdi>${plain(value)
    .match(/[^/]*\/?/g)
    .filter(Boolean)
    .map((part) => `<span class="path-part">${esc(part)}</span>`)
    .join("")}</bdi>`;

// Whether a row can be deleted at all, and whether only by discarding
// something. A row still being checked is neither.
const deletable = (row) => !row.pending && (row.canRemove || row.canDiscard);

// What deleting one worktree means, in a line: why it is recommended, or
// that its branch keeps what is not merged, or what would be discarded.
// `tone` is "safe" where nothing is lost, "risk" where something is, and
// "kept" where the worktree cannot be deleted and so will not be.
export function deletionMeaning(row) {
  const sentence = (text) => text.replace(/[.\s]+$/, "");
  if (!deletable(row))
    return {
      tone: "kept",
      text: `Cannot be deleted: ${sentence((row.blockers || []).concat(row.problems || []).join("; ") || "it is still being checked")}`,
    };
  if (row.recommended) return { tone: "safe", text: recommendationReason(row) };
  const lost = lossesOf(row);
  if (lost.length)
    return {
      tone: "risk",
      text: `Not a clean delete. Discards ${lost.map((name) => LOSSES[name].text).join("; ")}`,
    };
  // Deleted only by being told to, though nothing in it is lost: a lock is
  // overridden, a detached commit is given a branch, a folder is already gone.
  if (!row.canRemove)
    return {
      tone: "note",
      text: sentence(
        (row.discardWarnings || []).join(" ") ||
          (row.blockers || []).join("; ") ||
          "Deleted only because you ask",
      ),
    };
  return {
    tone: "safe",
    text: row.fresh
      ? "Clean. Created in the last 24 hours, with nothing of its own yet"
      : `Clean. Not merged${row.defaultRef ? ` into ${row.defaultRef.replace(/^refs\/(?:heads|remotes)\//, "")}` : ""}; its branch keeps its commits`,
  };
}

// Everything the review says about a worktree. One that no longer matches
// what was read is a different worktree to agree to.
const described = (row) =>
  JSON.stringify([
    row.host || "",
    row.path,
    row.head,
    branchName(row),
    row.repo || "",
    deletionMeaning(row),
  ]);

// Delete recommended deletes nothing by itself. It opens this review: every
// worktree it would delete and why each is one Arbor recommends, with the
// decision left to a second button. Deleting several worktrees chosen by
// hand opens the same review, of those: every one of them is listed, shown
// in the list or not, with what deleting it means.
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
    said = "",
    // What is under review: the recommendations, or rows chosen by hand.
    chosen = false,
    // Those that could not be deleted when the review opened. They are
    // listed, since they were chosen, and say why they stay.
    refused = new Set();
  const hostLabel = (row) =>
    workspace.snapshot.hosts.find((source) => source.host === (row.host || ""))
      ?.label ||
    row.host ||
    "This computer";
  // The reviewed rows that are still what the review says they are, as they
  // are now. Looking is what finds one changed, and it stays kept.
  function standing() {
    const current = new Map(
      (chosen ? workspace.items : recommendedShown(shown)).map((row) => [
        row.id,
        row,
      ]),
    );
    return reviewed.flatMap((row) => {
      const now = current.get(row.id);
      if (!now || described(now) !== described(row)) kept.add(row.id);
      return kept.has(row.id) || refused.has(row.id) ? [] : [now];
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
        const meaning = deletionMeaning(row);
        return `<li class="cleanup-item${refused.has(row.id) ? " refused" : ""}" data-review="${esc(row.id)}" data-tone="${meaning.tone}">${icon("branch")}<span class="cleanup-name">${named(name)}</span><span class="cleanup-size">${row.missing ? "—" : size(row.sizeBytes)}</span><span class="cleanup-kept">Kept</span><span class="cleanup-context">${context}</span><span class="cleanup-reason">${named(meaning.text)}</span><span class="cleanup-changed">Changed since you opened this list, so it is kept.</span><span class="cleanup-path">${pathed(row.path)}</span></li>`;
      })
      .join("");
  }
  // Everything about the review that can change after its list is drawn.
  function update() {
    const rows = standing(),
      count = plural(rows.length, "worktree"),
      ready = available(rows);
    const fewer = kept.size || refused.size,
      sort = chosen ? "" : "recommended ";
    $("#cleanup-title").textContent = !rows.length
      ? !kept.size
        ? reviewed.length === 1
          ? "This worktree cannot be deleted"
          : "None of these worktrees can be deleted"
        : reviewed.length === 1
          ? "This worktree has changed"
          : "These worktrees have changed"
      : reviewed.length === 1
        ? `Delete this ${sort}worktree?`
        : `Delete ${fewer ? `${rows.length} of these` : "these"} ${reviewed.length} ${sort}worktrees?`;
    $("#cleanup-list")
      .querySelectorAll("[data-review]")
      .forEach((item) =>
        item.classList.toggle("changed", kept.has(item.dataset.review)),
      );
    // Rows chosen by hand stay chosen when a search or a closed folder
    // takes them out of the list, so the review says how many it holds
    // that the list is not showing.
    const inList = new Set(
        (shown().visible || shown().filtered).map((row) => row.id),
      ),
      unseen = rows.filter((row) => !inList.has(row.id)).length;
    const scope = chosen
      ? unseen
        ? `${unseen} not shown in the list`
        : "The worktrees you selected"
      : shown().filtering
        ? "Only what the list is showing"
        : workspace.snapshot.hostFilter === null
          ? "All hosts"
          : workspace.snapshot.host || "This computer";
    // Deleting what is not clean is asked about once more, by name.
    const unclean = rows.filter((row) => !row.canRemove).length;
    const waiting = rows.length > 0 && !ready;
    waited ||= waiting;
    // An operation on a worktree's host ends by itself. Anything else that
    // stops a deletion, such as a lost connection, may not.
    $("#cleanup-total").textContent = !rows.length
      ? chosen
        ? "Nothing here would be deleted."
        : "Close this list and open it again to see what is recommended now."
      : !waiting
        ? `About ${size(sizeOf(rows))} to recover · ${scope}`
        : workspace.blocked
          ? "Deleting is unavailable for now."
          : "Deleting is unavailable until the current operation finishes.";
    const confirm = $("#cleanup-confirm");
    confirm.textContent = !rows.length
      ? "Delete"
      : unclean
        ? `Delete ${count}…`
        : `Delete ${count}`;
    confirm.title = unclean
      ? `${plural(unclean, "worktree")} here ${unclean === 1 ? "is" : "are"} not a clean delete. You are asked once more before anything is discarded.`
      : "";
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
  function render() {
    if (dialog.open) update();
  }
  // What the review says above its list, which depends on what is in it.
  function renderLead() {
    const going = reviewed.filter((row) => !refused.has(row.id)),
      unclean = going.filter((row) => !row.canRemove && lossesOf(row).length);
    const said = [
      "Deleting these worktrees removes their folders for good: they are not moved to Trash, and Arbor cannot bring them back. Their branches and commits are kept.",
      !chosen
        ? "Each one has no uncommitted changes, untracked files or ignored files, and its commits are already merged."
        : unclean.length
          ? `${unclean.length === going.length ? (going.length === 1 ? "It is" : "All of them are") : `${unclean.length} of them ${unclean.length === 1 ? "is" : "are"}`} not a clean delete. What each would lose is marked, and you are asked once more before anything is discarded.`
          : "None of them has uncommitted changes, untracked files or ignored files.",
      refused.size
        ? `${plural(refused.size, "worktree")} you selected cannot be deleted and ${refused.size === 1 ? "is" : "are"} left alone.`
        : "",
    ];
    $("#cleanup-lead").innerHTML = said
      .filter(Boolean)
      .map((text) => `<p>${esc(text)}</p>`)
      .join("");
    $("#cleanup-list").setAttribute(
      "aria-label",
      chosen
        ? "The worktrees you selected, and what deleting each one means"
        : "The worktrees that would be deleted, and why each is recommended",
    );
  }
  function begin(rows, byHand) {
    if (dialog.open || workspace.blocked || !workspace.snapshot.revision)
      return;
    reviewed = rows;
    if (!reviewed.length) return;
    chosen = byHand;
    refused = new Set(
      reviewed.filter((row) => !deletable(row)).map((row) => row.id),
    );
    kept = new Set();
    waited = false;
    renderLead();
    $("#cleanup-status").textContent = said = "";
    renderList();
    // What it asks is in place before it is shown, and before anything in it
    // is given the keyboard: neither is announced with the last review's words.
    update();
    dialog.showModal();
    // It opens at its beginning. Where there is so little room that the
    // buttons are out of sight below the list, the keyboard starts at the
    // heading with it, not on a Cancel that cannot be seen.
    dialog.scrollTop = $("#cleanup-body").scrollTop = 0;
    if (dialog.scrollHeight > dialog.clientHeight)
      $("#cleanup-title").focus({ preventScroll: true });
  }
  const open = () => begin(recommendedShown(shown), false);
  // The same review, of rows chosen by hand: ticked, or under one folder.
  const openFor = (rows) => begin([...rows], true);
  $("#cleanup-cancel").onclick = () => dialog.close();
  $("#cleanup-confirm").onclick = () => {
    const rows = standing();
    if (!rows.length || !available(rows)) return;
    dialog.close();
    const deleting = chosen
      ? workspace.deleteWorktrees(rows, { reviewed: true })
      : workspace.remove(rows, true);
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
  return { open, openFor, render };
}
