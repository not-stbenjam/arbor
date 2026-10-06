import { shown, plain, size } from "./presentation.mjs";
import { LOSSES } from "../common/losses.mjs";

const measured = (bytes, lower) => `${lower ? "at least " : ""}${size(bytes)}`;
const heading = (kind) =>
  LOSSES[kind].brief.replace(/^./, (letter) => letter.toUpperCase());

export function filesContent(report) {
  const groups = Object.keys(LOSSES).filter((kind) => report.counts[kind]);
  return (
    groups
      .map((kind) => {
        const entries = report.entries.filter((entry) => entry.kind === kind);
        const more = report.counts[kind] - entries.length;
        return `<section class="files-group"><h3>${heading(kind)} <span>(${report.counts[kind]})</span></h3><ul>${entries
          .map(
            (entry) =>
              `<li><bdi class="files-path">${shown(entry.path)}</bdi><span class="files-size">${measured(entry.sizeBytes, entry.sizeLowerBound)}</span>${entry.status || entry.directory ? `<span class="files-detail">${entry.status ? shown(entry.status) : ""}${entry.status && entry.directory ? " · " : ""}${entry.directory ? `${entry.sizeLowerBound ? "at least " : ""}${entry.files || 0} files` : ""}</span>` : ""}</li>`,
          )
          .join("")}</ul>${more ? `<p>and ${more} more</p>` : ""}</section>`;
      })
      .join("") +
    (!groups.length
      ? "<p>No files or worktree metadata to discard were found.</p>"
      : "") +
    report.warnings.map((warning) => `<p>${shown(warning)}</p>`).join("")
  );
}

export function createFilesController({ document, api, workspace }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#files-dialog");
  let request = 0,
    opener, deletingRow;
  dialog.addEventListener("close", () => {
    request++;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
  $("#files-close").onclick = () => dialog.close();
  $("#files-delete").onclick = () => {
    const row = workspace.items.find((item) => item.id === deletingRow?.id);
    dialog.close();
    if (row) return workspace.deleteWorktrees([row]);
  };
  async function open(row, revision = workspace.snapshot.revision, { deleting = false } = {}) {
    deletingRow = deleting ? row : null;
    $("#files-delete").hidden = !deleting;
    const current = ++request;
    if (!dialog.open) opener = document.activeElement;
    const name = row.path.split("/").filter(Boolean).pop() || row.path;
    $("#files-title").textContent = `Show Files — ${plain(name)}`;
    $("#files-path").textContent = plain(`${row.host ? `${row.host}: ` : ""}${row.path}`);
    $("#files-content").innerHTML = "";
    $("#files-total").textContent = "";
    $("#files-status").textContent = "Loading what this worktree holds…";
    if (!dialog.open) dialog.showModal();
    $("#files-title").focus({ preventScroll: true });
    $("#files-body").scrollTop = dialog.scrollTop = 0;
    try {
      const report = await api.worktreeFiles({ id: row.id, revision });
      // Closing, or opening another row, makes the old answer irrelevant.
      if (current !== request || !dialog.open) return;
      $("#files-status").textContent = "";
      $("#files-content").innerHTML = filesContent(report);
      // A count and no size: a folder can be under more than one heading,
      // and adding the headings up would count it twice.
      const count = Object.values(report.counts).reduce(
        (sum, value) => sum + value,
        0,
      );
      $("#files-total").textContent =
        `${count} ${count === 1 ? "item" : "items"}`;
    } catch (error) {
      if (current !== request || !dialog.open) return;
      $("#files-status").textContent =
        `Could not show what this worktree holds: ${plain(error.message)}`;
    }
  }
  return { open };
}
