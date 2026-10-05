"use strict";

// Stands in for desktop/preload.cjs while the promotional video is drawn.
// The real window code runs unchanged inside a frame of the composition; this
// gives it an invented workspace in place of a backend, holds its clock
// still, and lets the composition say when things happen.

const { webFrame } = require("electron");
const data = require("./data.cjs");

if (/\/desktop\/renderer\/index\.html$/.test(location.pathname)) {
  // A render takes minutes of real time for seconds of video. The window
  // must not notice: its clock stands at one moment, the checks it makes of
  // its backend every second or so happen at once, and a notification stays
  // until the video is done with it.
  const RealDate = Date;
  class StillDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(data.NOW);
    }
    static now() {
      return data.NOW;
    }
  }
  window.Date = StillDate;
  const realTimeout = window.setTimeout.bind(window);
  window.setTimeout = (run, delay = 0, ...rest) =>
    delay >= 5000 ? 0 : realTimeout(run, delay >= 300 ? 15 : delay, ...rest);

  let rows = data.WORKTREES.map((row) => ({ ...row }));
  let current = data.state(rows);
  let removal = null;
  const copy = (value) => JSON.parse(JSON.stringify(value));

  const backend = {
    // The deletion the window asked for, once it has: which worktrees.
    get removal() {
      return removal && removal.items;
    },
    // How far the deletion has got. `gone` names the worktrees finished.
    progress({ completed, files, filesTotal, file, path, gone = [] }) {
      rows = rows.filter((row) => !gone.includes(row.id));
      current = data.state(rows, {
        busy: true,
        operation: "remove",
        revision: null,
        progress: {
          stage: "removing",
          path,
          discovered: 0,
          completed,
          total: removal.items.length,
          startedAt: data.NOW,
          current: file,
          files,
          filesTotal,
        },
      });
    },
    finish() {
      const done = removal;
      removal = null;
      current = data.state(rows, { revision: "scan-2" });
      done.resolve({
        results: done.paths.map((path) => ({ path, removed: true, host: "" })),
        report: copy(current.report),
        revision: current.revision,
      });
    },
  };
  window.__backend = backend;

  window.arbor = Object.freeze({
    platform: "darwin",
    getDefaults: async () => copy(data.DEFAULTS),
    getState: async () => copy(current),
    getStats: async (host) => ({ host, report: copy(data.STATISTICS) }),
    setHostFilter: async () => copy(current),
    refreshHosts: async () => copy(current),
    scan: async () => copy(current),
    completeSetup: async () => copy(current),
    cancelScan: async () => copy(current),
    remove: (selection) =>
      new Promise((resolve) => {
        const chosen = new Set(selection.items.map((item) => item.id));
        removal = {
          items: selection.items,
          paths: rows.filter((row) => chosen.has(row.id)).map((row) => row.path),
          resolve,
        };
        backend.progress({
          completed: 0,
          files: 0,
          filesTotal: 0,
          file: "",
          path: removal.paths[0],
        });
      }),
    chooseFolder: async () => null,
    getPreferences: async () => copy(data.PREFERENCES),
    savePreferences: async (value) => value,
    resetPreferences: async () => copy(data.PREFERENCES),
    showWorktreeMenu: async () => true,
    onMenuAction: () => () => {},
  });

  // The typefaces the video is set in, for the window as well: the system
  // faces its stylesheet asks for are whatever this machine happens to have.
  webFrame.insertCSS(
    `:root, body, button, input, select, textarea { font-family: "Inter Variable", "Inter", sans-serif !important; }
     #root-label, .cleanup-path, .host-progress-path, .host-progress-file, code { font-family: "JetBrains Mono", monospace !important; }
     ::-webkit-scrollbar { width: 0; height: 0; }
     .promo-hover-cleanup { background: color-mix(in srgb, var(--red) 12%, var(--red-bg)) !important; border-color: var(--red) !important; }
     .promo-hover-danger { filter: brightness(0.93); }`,
  );
}

// The composition itself is told what the invented workspace holds, for the
// scenes that are about the worktrees rather than about the window.
if (/\/promo\/composition\//.test(location.pathname))
  window.__workspace = data.WORKTREES.map((row) => ({
    id: row.id,
    name: row.path.split("/").pop(),
    repo: row.repo,
    branch: row.branch,
    bytes: row.sizeBytes,
    recommended: row.recommended,
  }));
