import { shown, plain, size } from "./presentation.mjs";
import { LOSSES } from "../common/losses.mjs";

const measured = (bytes, lower) => `${lower ? "at least " : ""}${size(bytes)}`;
const heading = (kind) =>
  LOSSES[kind].brief.replace(/^./, (letter) => letter.toUpperCase());

const fileList = (entries) =>
  `<ul>${entries
    .map(
      (entry) =>
        `<li><bdi class="files-path">${shown(entry.path)}</bdi><span class="files-size">${measured(entry.sizeBytes, entry.sizeLowerBound)}</span>${entry.status || entry.directory ? `<span class="files-detail">${entry.status ? shown(entry.status) : ""}${entry.status && entry.directory ? " · " : ""}${entry.directory ? `${entry.sizeLowerBound ? "at least " : ""}${entry.files || 0} ${entry.files === 1 ? "file" : "files"}` : ""}</span>` : ""}</li>`,
    )
    .join("")}</ul>`;

const fileGroup = (title, entries, count = entries.length, more = 0) =>
  `<section class="files-group"><h3>${title} <span>(${count})</span></h3>${fileList(entries)}${more ? `<p>and ${more} more</p>` : ""}</section>`;

export function filesContent(report) {
  const groups = Object.keys(LOSSES).filter((kind) => report.counts[kind]);
  const ignored = report.entries.filter((entry) => entry.kind === "ignored");
  const needsReview = ignored.filter((entry) => !entry.safeIgnored);
  const consideredSafe = ignored.filter((entry) => entry.safeIgnored);
  const moreIgnored = (report.counts.ignored || 0) - ignored.length;
  return (
    groups
      .map((kind) => {
        if (kind === "ignored") {
          return needsReview.length ? fileGroup("Needs review", needsReview) : "";
        }
        const entries = report.entries.filter((entry) => entry.kind === kind);
        return fileGroup(
          heading(kind),
          entries,
          report.counts[kind],
          report.counts[kind] - entries.length,
        );
      })
      .join("") +
    (consideredSafe.length
      ? fileGroup("Considered safe by your settings", consideredSafe)
      : "") +
    // The report does not classify entries omitted by its display limit.
    (moreIgnored > 0
      ? `<p>Ignored files: ${moreIgnored} more not shown.</p>`
      : "") +
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
    opener,
    deletingRow,
    reveal,
    loading = false;
  const finish = () => {
    loading = false;
    clearTimeout(reveal);
    $("#files-loading").hidden = true;
    dialog.setAttribute("aria-busy", "false");
  };
  const cancel = () => {
    if (loading) api.cancelFiles?.(request)?.catch(() => {});
    finish();
  };
  const update = (event) => {
    if (!loading || event.request !== request || !dialog.open) return;
    const labels = {
      connecting: "Connecting to the host…",
      "files-git": "Asking Git what has changed…",
      "files-search": "Looking through the folder…",
      "files-measure": "Adding up sizes…",
    };
    const label = labels[event.stage];
    if (!label) return;
    const status = $("#files-status"),
      bar = $("#files-progress");
    if (status.textContent !== label) status.textContent = label;
    const count =
      event.stage === "files-search"
        ? ` ${event.discovered.toLocaleString()} files`
        : event.stage === "files-measure"
          ? ` ${event.completed.toLocaleString()} of ${event.total.toLocaleString()}`
          : "";
    $("#files-count").textContent = count;
    bar.setAttribute("aria-valuetext", label + count);
    if (event.stage === "files-measure" && event.total > 0) {
      bar.max = event.total;
      bar.value = event.completed;
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", String(event.total));
      bar.setAttribute("aria-valuenow", String(event.completed));
    } else {
      for (const name of ["value", "max", "aria-valuemin", "aria-valuemax", "aria-valuenow"])
        bar.removeAttribute(name);
    }
  };
  api.onFilesProgress?.(update);
  dialog.addEventListener("close", () => {
    cancel();
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
    cancel();
    const current = ++request;
    loading = true;
    $("#files-progress").hidden = false;
    dialog.setAttribute("aria-busy", "true");
    if (!dialog.open) opener = document.activeElement;
    const name = row.path.split("/").filter(Boolean).pop() || row.path;
    $("#files-title").textContent = `Files discarded with ${plain(name)}`;
    $("#files-path").textContent = plain(`${row.host ? `${row.host}: ` : ""}${row.path}`);
    $("#files-content").innerHTML = "";
    $("#files-total").textContent = "";
    $("#files-status").textContent = "Loading the files…";
    $("#files-count").textContent = "";
    for (const name of ["value", "max", "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"])
      $("#files-progress").removeAttribute(name);
    reveal = setTimeout(() => {
      if (loading && current === request) $("#files-loading").hidden = false;
    }, 150);
    if (!dialog.open) dialog.showModal();
    $("#files-title").focus({ preventScroll: true });
    $(".files-results").scrollTop = dialog.scrollTop = 0;
    try {
      const report = await api.worktreeFiles({
        id: row.id,
        revision,
        request: current,
      });
      // Closing, or opening another row, makes the old answer irrelevant.
      if (current !== request || !dialog.open) return;
      finish();
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
      finish();
      $("#files-loading").hidden = false;
      $("#files-progress").hidden = true;
      $("#files-count").textContent = "";
      $("#files-status").textContent =
        `Could not show what this worktree holds: ${plain(error.message)}`;
    }
  }
  return { open };
}
