import {
  icon,
  esc,
  branchName,
  size,
  sizeOf,
  ago,
  fullDate,
  parsedDate,
  repoID,
} from "./presentation.mjs";
import { LOSSES, lossesOf, graveLosses } from "../common/losses.mjs";

// Pure tree projection and markup. No DOM, IPC, timers, or mutable view state.

// DOM id of a worktree's row, for the grid's active-descendant reference.
export const rowElementID = (id) => `worktree-row-${id}`;

// The one fact that most affects a cleanup decision, or nothing at all. A row
// that needs no comment stays quiet; the confirmation still states every risk.
// Why a worktree is one Arbor recommends deleting. Every one of them is
// clean; what differs is the evidence that its commits are merged. Git's
// full names for a branch are shortened to the names people use for it.
export const recommendationReason = (w) =>
  (w.mergeReason || "All of its commits are in the default branch").replace(
    /\brefs\/(?:heads|remotes)\//g,
    "",
  );
export function worktreeState(w) {
  if (w.pending) return null;
  if (!w.canRemove && !w.canDiscard) {
    const reasons = (w.blockers || []).concat(w.problems || []);
    return {
      tone: "blocked",
      label:
        reasons.length === 1 ? reasons[0].split(":")[0] : "Cannot be deleted",
      detail: reasons.join("\n"),
    };
  }
  // Commits or a repository that would be lost outrank everything else a
  // row could say, a missing folder included: what Git kept for a worktree's
  // submodules outlives the folder and still goes with the registration.
  const grave = ["nested", "submodules", "operation"].find((name) =>
    graveLosses(w).includes(name),
  );
  if (grave)
    return {
      tone: "caution",
      label: LOSSES[grave].brief.replace(/^./, (c) => c.toUpperCase()),
      detail: `Deleting this worktree discards ${lossesOf(w)
        .map((name) => LOSSES[name].text)
        .join("; ")}.`,
    };
  if (w.missing)
    return {
      tone: "muted",
      label: "Folder missing",
      detail:
        "The folder is gone. Deleting removes only its leftover Git registration.",
    };
  if (w.empty)
    return {
      tone: "muted",
      label: "Empty folder",
      detail:
        "The folder is empty. Deleting removes it and its leftover Git registration.",
    };
  if (w.dirty)
    return {
      tone: "caution",
      label:
        w.changedFiles > 0
          ? `${w.changedFiles} changed ${w.changedFiles === 1 ? "file" : "files"}`
          : "Uncommitted changes",
      detail:
        "Uncommitted or untracked files. Deleting this worktree discards them.",
    };
  if (w.ignored)
    return {
      tone: "caution",
      label: "Ignored files",
      detail:
        "Deleting this worktree discards its ignored files, such as local configuration or build output.",
    };
  if (w.locked)
    return {
      tone: "muted",
      label: "Locked",
      detail: w.lockReason || "Locked with git worktree lock.",
    };
  // Any other reason that only an explicit discard gets past is named by the
  // words before its explanation, such as files Git was told not to check or
  // a checkout of a protected branch. Orange is for what could be lost. A
  // detached HEAD is already named where the branch would be.
  if (!w.canRemove && w.canDiscard && !w.detached && w.blockers?.length)
    return {
      tone: lossesOf(w).length ? "caution" : "muted",
      label: w.blockers[0].split(/[:;(]/)[0].trim(),
      detail: w.blockers.join("\n"),
    };
  if (w.fresh)
    return {
      tone: "muted",
      label: "New",
      detail:
        "Created in the last 24 hours, and its HEAD has not moved since. Delete recommended leaves it alone until one of those changes.",
    };
  // Green means exactly one thing: Delete recommended will remove this row. A
  // merged commit on a detached HEAD, say, is merged but not offered there.
  if (w.recommended)
    return {
      tone: "safe",
      label: "Merged",
      detail: `${recommendationReason(w)}. Clean, so Delete recommended includes it; its branch is kept.`,
    };
  return null;
}
export function projectRepositories(list, { hostFilter, hosts }) {
  const repositories = new Map();
  for (const worktree of list) {
    const id = repoID(worktree);
    if (!repositories.has(id)) {
      const name = worktree.repo || "Discovering…";
      const host = worktree.host || "";
      const machine =
        hosts.find((source) => source.host === host)?.label ||
        host ||
        "This computer";
      repositories.set(id, {
        id,
        name: hostFilter === null ? `${name} · ${machine}` : name,
        title:
          hostFilter === null
            ? `${host || "This computer"}:${worktree.commonDir || worktree.repo || worktree.path}`
            : id,
        count: 0,
      });
    }
    repositories.get(id).count++;
  }
  return [...repositories.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function renderRepositoryList(repositories, selectedRepo) {
  return repositories.length
    ? repositories
        .map(
          (repo) =>
            `<button class="repo-item${repo.id === selectedRepo ? " active" : ""}" data-repo="${esc(repo.id)}" title="${esc(repo.title || repo.id)}">${icon("folder")}<span>${esc(repo.name)}</span><span class="count">${repo.count}</span></button>`,
        )
        .join("")
    : '<p class="repo-empty">No repositories found.</p>';
}

export function projectTree(
  list,
  {
    root,
    repo,
    view,
    search,
    sort,
    descending,
    collapsedDirectories,
    hostFilter,
    hosts,
  },
  tree,
) {
  const query = search.trim().toLowerCase();
  const filtered = tree.filter(list, { repo, view, query });
  const value = (descendants) =>
    sort === "size"
      ? sizeOf(descendants)
      : sort === "activity"
        ? Math.max(
            ...descendants.map((w) => parsedDate(w.activityAt)?.valueOf() || 0),
          )
        : sort === "branch"
          ? branchName(descendants[0])
          : sort === "repo"
            ? descendants[0].repo || ""
            : descendants[0].path;
  const compare = (a, b) => {
    if (sort === "path") return 0;
    const left = value(a),
      right = value(b);
    return (
      (typeof left === "number" ? left - right : left.localeCompare(right)) *
      (descending ? -1 : 1)
    );
  };
  function rowsFor(rows, rootPath, host) {
    const directoryTree = tree.build(rows, rootPath, host);
    if (sort === "path" && descending && directoryTree) {
      const reverse = (node) => {
        node.children.reverse();
        node.children.forEach(reverse);
      };
      reverse(directoryTree);
    }
    return tree.flatten(
      directoryTree,
      collapsedDirectories,
      sort === "path" ? undefined : compare,
    );
  }
  let directoryRows;
  if (hostFilter === null) {
    const grouped = new Map();
    for (const row of filtered) {
      const host = row.host || "";
      if (!grouped.has(host)) grouped.set(host, []);
      grouped.get(host).push(row);
    }
    directoryRows = [...grouped]
      .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .flatMap(([host, rows]) => {
        const source = hosts.find((entry) => entry.host === host);
        const key = JSON.stringify([host]);
        const group = {
          kind: "host",
          key,
          host,
          label: source?.label || host || "This computer",
          depth: 0,
          descendants: rows,
        };
        if (collapsedDirectories.has(key)) return [group];
        return [
          group,
          ...rowsFor(rows, source?.report?.root || source?.root, host).map(
            (entry) => ({ ...entry, depth: entry.depth + 1 }),
          ),
        ];
      });
  } else {
    // The path bar already shows this host's whole scan folder, so its row in
    // the list is that folder by name. All hosts keeps each full path above,
    // because the hosts' folders differ.
    directoryRows = rowsFor(filtered, root, hostFilter).map((entry, index) =>
      index === 0 && entry.kind === "directory"
        ? { ...entry, label: entry.node.name }
        : entry,
    );
  }
  const visible = directoryRows
    .filter((entry) => entry.kind === "worktree")
    .map((entry) => entry.worktree);
  return { filtered, directoryRows, visible };
}

export function renderTreeRows(
  directoryRows,
  { selected, collapsed, disabled, cancelled, canDelete = () => true },
) {
  const indentation = (depth) =>
    '<span class="tree-indent" aria-hidden="true"></span>'.repeat(
      Math.min(depth, 12),
    );
  // A folder's box ticks the rows shown beneath it. The view sets its state,
  // which depends on what is selected and on which folders are open.
  // A folder has no row of its own for the keyboard to stand on, so its box
  // is a tab stop. A worktree's is not: Space ticks the row the cursor is on.
  const folderCheck = (key, name) =>
    `<td class="check-cell"><input type="checkbox" class="row-check" data-select-folder="${esc(key)}" aria-label="Select the worktrees shown under ${esc(name)}" /></td>`;
  return directoryRows
    .map((entry) => {
      if (entry.kind === "host") {
        const expanded = !collapsed.has(entry.key);
        return `<tr class="directory-row host-row" data-host="${esc(entry.host)}" aria-level="1" aria-expanded="${expanded}">${folderCheck(entry.key, entry.label)}<td colspan="4" class="directory-cell"><div class="directory-line"><button class="directory-toggle" data-toggle-directory="${esc(entry.key)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(entry.label)}">${icon(expanded ? "chevron-down" : "chevron-right")}${icon(entry.host ? "server" : "monitor")}<span>${esc(entry.label)}</span></button><span class="directory-count">${entry.descendants.length} ${entry.descendants.length === 1 ? "worktree" : "worktrees"}</span></div></td></tr>`;
      }
      if (entry.kind === "directory") {
        const node = entry.node;
        const key = node.key || node.path;
        const expanded = !collapsed.has(key);
        const count = `${node.descendants.length} ${node.descendants.length === 1 ? "worktree" : "worktrees"}`;
        return `<tr class="directory-row" data-directory-path="${esc(node.path)}" data-host="${esc(node.host || "")}" aria-level="${entry.depth + 1}" aria-expanded="${expanded}">${folderCheck(key, node.path)}<td colspan="3" class="directory-cell"><div class="directory-line">${indentation(entry.depth)}<button class="directory-toggle" data-toggle-directory="${esc(key)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(node.path)}">${icon(expanded ? "chevron-down" : "chevron-right")}${icon("folder")}<span title="${esc(node.path)}">${esc(entry.label)}</span></button><span class="directory-count">${count}</span></div></td><td class="action-cell"><div class="row-actions"><button class="row-action folder-delete" data-folder-delete="${esc(key)}" title="Delete the ${count} shown under this folder. The folder itself is kept." aria-label="Delete the ${count} under ${esc(node.path)}; the folder is kept" ${disabled ? "disabled" : ""}>Delete…</button></div></td></tr>`;
      }
      const w = entry.worktree;
      const rowDisabled = disabled || !canDelete(w);
      // A row's buttons are for the pointer. The keyboard reaches the same
      // actions from the row itself, with Delete and Enter, so Tab moves
      // through folders rather than through two buttons for every worktree.
      // The folder rows above already say where this is. The row leads with
      // the worktree's own name; its full path stays one hover or copy away.
      const leaf = entry.label.split("/").pop();
      const prefix = entry.label.slice(0, -leaf.length);
      const name = `${prefix ? `<span class="path-chain">${esc(prefix)}</span>` : ""}<span class="path-basename">${esc(leaf)}</span>`;
      const state = worktreeState(w);
      const branch = branchName(w);
      // A row that is not a clean delete says so on the button that would
      // delete it, before the confirmation does.
      // (A missing folder has no files to lose; what Git kept for its
      // submodules it still can.)
      const lost = w.pending ? [] : w.missing ? graveLosses(w) : lossesOf(w);
      const deleteTitle = lost.length
        ? ` title="Not a clean delete. It would discard ${esc(lost.map((name) => LOSSES[name].text).join("; "))}. Asks first."`
        : "";
      const context = w.pending
        ? cancelled
          ? "Scan incomplete"
          : "Checking…"
        : `${state ? `${state.label} · ` : ""}${branch}${w.repo ? ` · ${w.repo}` : ""}`;
      const contextMarkup = w.pending
        ? `<span>${esc(context)}</span>`
        : `${state ? `<span class="worktree-state" data-tone="${state.tone}" title="${esc(state.detail)}">${esc(state.label)}</span><span> · </span>` : ""}<span class="worktree-branch">${esc(branch)}</span>${w.repo ? `<span> · </span><span class="worktree-repository">${esc(w.repo)}</span>` : ""}`;
      return `<tr class="worktree-row${selected.has(w.id) ? " selected" : ""}${w.pending ? " pending-row" : ""}" id="${esc(rowElementID(w.id))}" data-id="${esc(w.id)}" data-path="${esc(w.path)}" data-host="${esc(w.host || "")}" aria-level="${entry.depth + 1}" aria-selected="${selected.has(w.id)}"><td class="check-cell"><input type="checkbox" class="row-check" tabindex="-1" data-select="${esc(w.id)}" aria-label="Select ${esc(w.path)}"${selected.has(w.id) ? " checked" : ""} /></td><td class="branch-cell"><div class="tree-worktree-line">${indentation(entry.depth)}${icon("branch")}<div class="branch-copy"><span class="worktree-path" title="${esc(w.path)}"><span class="path-leaf">${name}</span></span><span class="worktree-context" title="${esc(context)}">${contextMarkup}</span></div></div></td><td class="activity-cell" title="${esc(fullDate(w.activityAt))}">${ago(w.activityAt)}</td><td class="size-cell">${w.pending || w.missing ? "—" : size(w.sizeBytes)}</td><td class="action-cell"><div class="row-actions"><button class="row-action" tabindex="-1" data-delete="${esc(w.id)}" aria-label="Delete ${esc(w.path)}${lost.length ? ", which is not a clean delete" : ""}"${deleteTitle} ${rowDisabled ? "disabled" : ""}>Delete</button><button class="icon-button row-menu" tabindex="-1" data-worktree-menu="${esc(w.id)}" aria-label="Actions for ${esc(w.path)}" title="Worktree actions">${icon("more")}</button></div></td></tr>`;
    })
    .join("");
}
