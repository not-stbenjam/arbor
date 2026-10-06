import { iconPaths } from "./icons.generated.mjs";

// Arbor's own mark, also used by the All worktrees view, is not an interface
// icon. Keep its original drawing and stroke; the packaged app mark is separate.
const arborMark = '<path d="M8 21V3m0 5L4 5m4 9-5-4m5 8 5-4M16 3v7m0-4 4-3m-4 7 4-3"/>';
const icon = (name, extra = "") => {
  const mark = name === "trees";
  if (!mark && !Object.hasOwn(iconPaths, name))
    throw new Error(`Unknown icon: ${name}`);
  return `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${mark ? 1.65 : 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mark ? arborMark : iconPaths[name]}</svg>`;
};
// Text that came from a repository, made safe to read: characters that
// cannot be seen, or that reverse the order of what follows them, are shown
// as a mark, so that two names that differ never look the same. (The
// joiners that some scripts and emoji are written with are left alone.) A folder named "safe<reverse>gnp.exe" would otherwise read as
// "safeexe.png".
const plain = (value) =>
  String(value ?? "").replace(
    /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    "\ufffd",
  );
// The same, ready to put in the page.
const shown = (value) => esc(plain(value));
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
const branchName = (w) =>
  w.branch ||
  (w.pending
    ? (w.path || "Worktree").split("/").filter(Boolean).pop()
    : w.bare
      ? "Bare repository"
      : "Detached HEAD");
const repoID = (w) =>
  w.host === undefined
    ? w.commonDir || w.repo || w.path
    : JSON.stringify([w.host, w.commonDir || w.repo || w.path]);
const parsedDate = (value) => {
  // Only a timestamp is ever a date; never coerce other report data.
  if (typeof value !== "string" && typeof value !== "number") return null;
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
// Every row formats a date and a size. Constructing a locale formatter per
// cell dominates the cost of drawing a long list, so each is built once.
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const wholeNumber = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const oneDecimal = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const fullDate = (value) => {
  const d = parsedDate(value);
  return d ? dateFormat.format(d) : "Unknown";
};
const size = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let u = 0;
  while (bytes >= 1024 && u < 4) {
    bytes /= 1024;
    u++;
  }
  return `${(u > 0 && bytes < 10 ? oneDecimal : wholeNumber).format(bytes)} ${units[u]}`;
};
const sizeOf = (list) =>
  list.reduce((n, w) => n + Math.max(0, w.sizeBytes || 0), 0);

export function initializeDOM() {
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
}
export function describeProgress(state, removing = false) {
  const progress = state.progress || {};
  const deleting = removing && progress.stage === "removing";
  const stage = state.cancelRequested
    ? "Stopping scan…"
    : state.cancelled && !state.busy
      ? "Scan stopped"
      : {
          queued: "Waiting to scan…",
          starting: "Starting scan…",
          discovery: "Finding Git repositories…",
          fetch: "Fetching remote branches…",
          inspect: "Checking worktrees…",
          connecting: "Connecting…",
          removing: "Deleting worktrees…",
        }[progress.stage] || "Scanning…";
  const totalKnown =
    Number.isFinite(progress.total) &&
    progress.total > 0 &&
    (deleting || ["fetch", "inspect"].includes(progress.stage));
  const completed = Math.max(0, Number(progress.completed) || 0);
  const countText = totalKnown
    ? `${completed} of ${progress.total}${progress.stage === "fetch" ? " repositories" : ""}`
    : Number(progress.discovered) > 0
      ? `${progress.discovered} found`
      : "";
  // How far along, from 0 to 1, when that is known. A deletion counts the
  // worktrees finished plus how much of the one in hand has gone.
  const files = Math.max(0, Number(progress.files) || 0),
    filesTotal = Math.max(0, Number(progress.filesTotal) || 0);
  const within = deleting && filesTotal ? Math.min(1, files / filesTotal) : 0;
  const fraction = totalKnown
    ? Math.min(1, (completed + within) / progress.total)
    : null;
  if (!deleting || state.cancelRequested)
    return { stage, totalKnown, completed, countText, fraction };
  return {
    // Which one it is on says more than how many are behind it.
    stage:
      progress.total > 1
        ? `Deleting worktree ${Math.min(completed + 1, progress.total)} of ${progress.total}…`
        : "Deleting worktree…",
    totalKnown,
    completed,
    countText: filesTotal
      ? `${wholeNumber.format(files)} of ${wholeNumber.format(filesTotal)} files`
      : "",
    fraction,
    // A file being deleted about now, inside the worktree named beside it.
    current: typeof progress.current === "string" ? progress.current : "",
  };
}
export {
  icon,
  esc,
  plain,
  shown,
  branchName,
  repoID,
  parsedDate,
  ago,
  fullDate,
  size,
  sizeOf,
};

// The command line's messages start in lower case. A line that opens with a
// plain word becomes a sentence; one that opens with a host's name, which
// ends in a colon, is left exactly as the host is spelled.
export const sentenceCase = (message) =>
  String(message ?? "").replace(
    /(^|\n)(\p{Ll})(?=\p{L}*\s)/gu,
    (_, start, letter) => start + letter.toUpperCase(),
  );

// With only this computer configured, All has the same scope as local.
// Keep that distinction out of the wording and directory hierarchy.
export const viewHost = ({ hostFilter, hosts = [] }) =>
  hostFilter === null && !hosts.some((source) => source.host)
    ? ""
    : hostFilter;
