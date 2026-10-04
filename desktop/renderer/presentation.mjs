const paths = {
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-3h6a6 6 0 0 0 6-6"/>',
  trees: '<path d="M8 21V3m0 5L4 5m4 9-5-4m5 8 5-4M16 3v7m0-4 4-3m-4 7 4-3"/>',
  merge:
    '<circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M7 7v10m11-10c0 7-11 3-11 10"/>',
  monitor:
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  server:
    '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6"/>',
  chevrons: '<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  settings:
    '<path d="m10 3-1 3-3 1-3 3 2 2-1 3 3 3 3-1 2 4 3-2 1-3 4-1 1-4-3-1-1-3-4-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  sliders:
    '<path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  cleanup:
    '<path d="m14 3 7 7M4 20l3-8 6-6 5 5-6 6-8 3Zm3-8 5 5M2 7h4m-2-2v4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sort: '<path d="m8 8 4-4 4 4m-8 8 4 4 4-4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  folder:
    '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  warning: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  external:
    '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  moon: '<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chart: '<path d="M4 3v18h17M9 16v-4m5 4V8m5 8V5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};
const icon = (name, extra = "") =>
  `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.branch}</svg>`;
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
const repoID = (w) => w.commonDir || w.repo || w.path;
const parsedDate = (value) => {
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
const fullDate = (value) =>
  parsedDate(value)?.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }) || "Unknown";
const size = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let u = 0;
  while (bytes >= 1024 && u < 4) {
    bytes /= 1024;
    u++;
  }
  return `${bytes.toLocaleString(undefined, { maximumFractionDigits: u > 0 && bytes < 10 ? 1 : 0 })} ${units[u]}`;
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
export {
  icon,
  esc,
  branchName,
  repoID,
  parsedDate,
  ago,
  fullDate,
  size,
  sizeOf,
};
