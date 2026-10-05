"use strict";

// The invented workspace the promotional video shows. Nothing here is read
// from a disk: every name, path, size and date is made up, and the window is
// fed these in place of a scan.

const GB = 1024 ** 3,
  MB = 1024 ** 2;
const ROOT = "/Users/sam/code";
// The moment the video takes place. The window's clock is held here, so a
// render that takes minutes does not age "Scanned just now".
const NOW = Date.parse("2026-10-06T16:30:00Z");
const MINUTE = 60e3,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;

const EXCLUDES = [
  ".cache",
  ".Trash",
  "node_modules",
  "tmp",
  "temp",
  "~/Library/Caches",
  "~/Library/Logs",
  "~/.local/share/Trash",
];

// One worktree, in the shape a scan reports it.
function worktree(repo, name, branch, age, size, facts = {}) {
  const sourceID = Buffer.from(`${repo}/${name}`)
    .toString("hex")
    .padEnd(24, "0")
    .slice(0, 24);
  const head = Buffer.from(`${name}:${repo}:head`)
    .toString("hex")
    .padEnd(40, "a")
    .slice(0, 40);
  return {
    id: Buffer.from(JSON.stringify(["", sourceID])).toString("base64url"),
    path: `${ROOT}/worktrees/${repo}/${name}`,
    repo,
    commonDir: `${ROOT}/${repo}/.git`,
    branch,
    head,
    subject: "",
    author: "Sam Rivera",
    commitAt: new Date(NOW - age).toISOString(),
    activityAt: new Date(NOW - age).toISOString(),
    sizeBytes: Math.round(size),
    main: false,
    bare: false,
    detached: false,
    locked: false,
    lockReason: "",
    missing: false,
    empty: false,
    outsideRoot: false,
    dirty: false,
    changedFiles: 0,
    ignored: false,
    upstream: "",
    ahead: 0,
    behind: 0,
    published: false,
    publishedRefs: [],
    defaultRef: "refs/remotes/origin/main",
    merged: false,
    mergeReason: "",
    fresh: false,
    githubState: "not_checked",
    recommended: false,
    canRemove: true,
    canDiscard: true,
    discardWarnings: [],
    losses: [],
    blockers: [],
    problems: [],
    pending: false,
    nativeRevision: "scan-1",
    sourceID,
    host: "",
    hostLabel: "This computer",
    ...facts,
  };
}

// Clean, with every commit already in the default branch: what Arbor
// recommends deleting.
const merged = (reason = "All commits are in refs/remotes/origin/main") => ({
  merged: true,
  mergeReason: reason,
  recommended: true,
  published: true,
});
const pullRequest = (number) => ({
  ...merged(`GitHub PR #${number} merged this exact commit into main`),
  githubState: "merged",
});
const changed = (files) => ({
  dirty: true,
  changedFiles: files,
  canRemove: false,
  losses: ["changes"],
  blockers: ["Uncommitted or untracked files"],
  discardWarnings: ["Uncommitted and untracked files will be deleted."],
});

const WORKTREES = [
  worktree("api", "billing-webhooks", "feature/billing-webhooks", 2 * HOUR, 2.4 * GB, changed(4)),
  worktree("api", "graphql-pagination", "feature/graphql-pagination", 25 * MINUTE, 1.8 * GB, {
    merged: true,
    mergeReason: "All commits are in refs/remotes/origin/main",
    fresh: true,
  }),
  worktree("api", "oauth-login", "feature/oauth-login", 36 * DAY, 2.1 * GB, pullRequest(482)),
  worktree("api", "rate-limit-headers", "fix/rate-limit-headers", 12 * DAY, 1.9 * GB, merged()),
  worktree("api", "release-2026-10", "release/2026-10", 2 * DAY, 2.2 * GB, {
    locked: true,
    lockReason: "release in progress",
    canRemove: false,
    blockers: ["Locked: release in progress"],
    discardWarnings: ["The worktree lock will be overridden."],
  }),
  worktree("api", "upgrade-deps", "chore/upgrade-deps", 19 * DAY, 3.2 * GB, {
    merged: true,
    mergeReason: "All commits are in refs/remotes/origin/main",
    ignored: true,
    canRemove: false,
    losses: ["ignored"],
    blockers: ["Ignored files on disk (may include local secrets or build output)"],
    discardWarnings: ["Ignored files will be deleted."],
  }),
  worktree("infra", "k8s-autoscaling", "feature/k8s-autoscaling", 6 * DAY, 380 * MB),
  worktree("infra", "terraform-1.9", "chore/terraform-1.9", 31 * DAY, 410 * MB, merged()),
  worktree("mobile", "ios-18-fixes", "fix/ios-18-fixes", 3 * DAY, 4.1 * GB),
  worktree("mobile", "offline-sync", "feature/offline-sync", 4 * DAY, 4.4 * GB, {
    canRemove: false,
    losses: ["operation"],
    blockers: [
      "Unfinished Git operation: a rebase, merge, cherry-pick, revert or bisect is in progress",
    ],
    discardWarnings: ["An unfinished Git operation will be discarded."],
  }),
  worktree("mobile", "push-notifications", "feature/push-notifications", 44 * DAY, 4.6 * GB, pullRequest(1207)),
  worktree("web", "checkout-redesign", "feature/checkout-redesign", 1 * DAY, 3.6 * GB, changed(12)),
  worktree("web", "dark-mode", "feature/dark-mode", 22 * DAY, 3.4 * GB, pullRequest(913)),
  worktree("web", "onboarding-copy", "chore/onboarding-copy", 63 * DAY, 2.9 * GB, merged()),
  worktree("web", "safari-flexbox", "fix/safari-flexbox", 23 * DAY, 3.1 * GB, merged()),
];

function hostState(rows, changes = {}) {
  const options = {
    root: ROOT,
    host: "",
    github: true,
    fetch: true,
    excludes: EXCLUDES,
  };
  return {
    busy: false,
    error: "",
    warning: "",
    root: ROOT,
    host: "",
    options,
    progress: null,
    cancelled: false,
    cancelRequested: false,
    canCancelScan: false,
    version: "v0.1.19",
    revision: "scan-1",
    cached: false,
    githubAvailable: true,
    platform: "darwin",
    operation: null,
    label: "This computer",
    sessionOnly: false,
    queued: false,
    report: {
      root: ROOT,
      worktrees: rows,
      warnings: [],
      scannedAt: new Date(NOW - 20e3).toISOString(),
      durationMs: 1840,
      github: true,
      fetched: true,
    },
    worktreeCount: rows.length,
    ...changes,
  };
}

// What the window is told: the selected host's state, and every host's.
function state(rows = WORKTREES, changes = {}) {
  const host = hostState(rows, changes);
  const { report, ...summary } = host;
  return {
    ...host,
    hostFilter: "",
    removing: host.operation === "remove",
    hosts: [
      {
        ...summary,
        report: {
          root: report.root,
          scannedAt: report.scannedAt,
          durationMs: report.durationMs,
          github: report.github,
          fetched: report.fetched,
        },
      },
    ],
  };
}

const DEFAULTS = { excludes: EXCLUDES, maxExcludes: 128 };
const scan = { root: ROOT, host: "", github: true, fetch: true, excludes: EXCLUDES };
const PREFERENCES = {
  theme: "light",
  hosts: [],
  roots: [ROOT],
  setupCompleted: true,
  exclusionDefaultsVersion: 2,
  scan,
  scans: [scan],
};

const day = (n) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
const STATISTICS = {
  version: 1,
  removedWorktrees: 214,
  estimatedBytesReclaimed: Math.round(187.4 * GB),
  missingRegistrations: 9,
  cleanupSessions: 31,
  largestWorktreeBytes: Math.round(12.3 * GB),
  detachedCommitsRetained: 17,
  firstCleanupAt: new Date(NOW - 80 * DAY).toISOString(),
  lastCleanupAt: new Date(NOW - 3 * HOUR).toISOString(),
  daily: [29, 24, 23, 17, 16, 11, 9, 8, 4, 2, 1, 0].map((n, i) => ({
    date: day(n),
    removedWorktrees: [3, 1, 7, 2, 12, 4, 1, 9, 5, 2, 6, 3][i],
    estimatedBytesReclaimed: Math.round(
      [2.1, 0.4, 9.8, 1.2, 14.6, 3.3, 0.2, 7.9, 4.4, 0.9, 5.2, 1.7][i] * GB,
    ),
  })),
};

module.exports = {
  ROOT,
  NOW,
  WORKTREES,
  DEFAULTS,
  PREFERENCES,
  STATISTICS,
  state,
};
