import { shown, plain, size, ago, fullDate } from "./presentation.mjs";

export function undoAction(results, restore) {
  if (!results.length || results.some((r) => !r.restoreID || r.missing))
    return undefined;
  const ids = results.map((r) => r.restoreID);
  return { label: "Undo", run: () => restore(ids) };
}
export function restoreNotice(results) {
  const restored = results.filter((r) => r.restored);
  const failed = results.filter((r) => !r.restored);
  const n = restored.length;
  let message = n
    ? `Put back ${n} worktree${n === 1 ? "" : "s"}.`
    : "No worktrees were put back.";
  if (restored.some((r) => r.safeIgnoredOnly)) message += " Ignored files are not restored.";
  if (restored.some((r) => !r.clean && !r.safeIgnoredOnly))
    message +=
      n === 1
        ? " The uncommitted files it had were discarded and are not back."
        : " Uncommitted files discarded during deletion are not back.";
  if (restored.some((r) => r.moved))
    message +=
      " A branch has moved since deletion; its current commit was restored.";
  for (const r of failed)
    message += ` ${plain(r.path)}: ${plain(r.error || "Could not restore")}`;
  for (const r of restored.filter((r) => r.warning))
    message += ` ${plain(r.warning)}`;
  return {
    message,
    error: failed.length > 0 || restored.some((r) => r.warning),
  };
}

export function createRestoreController({
  document,
  api,
  notify,
  reload,
  hostName = (host) => host || "This computer",
}) {
  const dialog = document.querySelector("#restore-dialog");
  const content = document.querySelector("#restore-content");
  let entries = [],
    errors = new Map(),
    busy = false,
    generation = 0,
    opener;
  function render() {
    content.innerHTML = entries.length
      ? entries
          .map(
            (entry) => `
      <article class="restore-entry" data-restore-entry="${shown(entry.id)}">
        <div><h3>${shown(entry.path.split("/").filter(Boolean).pop())}</h3>
        <p>${shown(entry.branch || "Detached HEAD")} · ${shown(entry.repo)} · ${shown(hostName(entry.host))}</p>
        <p class="restore-path">${shown(entry.path)}</p>
        <p title="${shown(fullDate(entry.deletedAt))}">${shown(ago(entry.deletedAt))} · ${shown(size(entry.sizeBytes))}</p>
        ${entry.clean ? "" : '<p class="restore-loss">Uncommitted files and other work discarded during deletion are not restored.</p>'}
        ${errors.has(entry.id) ? `<p class="restore-error" role="status">${shown(errors.get(entry.id))}</p>` : ""}</div>
        <button class="button" data-restore="${shown(entry.id)}" ${busy ? "disabled" : ""}>Restore</button>
      </article>`,
          )
          .join("")
      : "<p>Nothing deleted in the last 30 days.</p>";
  }
  async function restore(ids) {
    if (busy) return;
    busy = true;
    if (dialog.open) render();
    try {
      const response = await api.restore(ids);
      for (const result of response.results) {
        if (result.restored) errors.delete(result.id);
        else errors.set(result.id, result.error || "Could not restore");
      }
      const notice = restoreNotice(response.results);
      notify(notice.message, notice.error);
      await reload();
      entries = await api.listDeletions();
    } catch (error) {
      for (const id of ids) errors.set(id, error.message);
      notify(plain(error.message), true);
    } finally {
      busy = false;
      if (dialog.open) {
        render();
        const failed = content.querySelector(`[data-restore="${ids[0]}"]`);
        (failed || content).focus();
      }
    }
  }
  content.addEventListener("click", (event) => {
    const button = event.target.closest("[data-restore]");
    if (button && !busy) restore([button.dataset.restore]);
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    generation++;
    if (opener?.isConnected) opener.focus();
  });
  return {
    restore,
    async open() {
      const current = ++generation;
      opener = document.activeElement;
      content.textContent = "Loading recent deletions…";
      if (!dialog.open) dialog.showModal();
      content.focus();
      try {
        const found = await api.listDeletions();
        if (current !== generation || !dialog.open) return;
        entries = found;
        render();
      } catch (error) {
        if (current === generation && dialog.open)
          content.textContent = plain(error.message);
      }
    },
  };
}
