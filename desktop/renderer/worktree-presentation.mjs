import {
  icon,
  esc,
  branchName,
  size,
  sizeOf,
  ago,
  fullDate,
  parsedDate,
} from "./presentation.mjs";

// Pure tree projection and markup. No DOM, IPC, timers, or mutable view state.
export function projectTree(
  list,
  { root, repo, view, search, sort, descending, collapsedDirectories },
  tree,
) {
  const query = search.trim().toLowerCase();
  const filtered = tree.filter(list, { repo, view, query });
  const directoryTree = tree.build(filtered, root);
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
  let directoryRows = tree.flatten(
    directoryTree,
    collapsedDirectories,
    sort === "path" && !descending ? undefined : compare,
  );
  if (sort === "path" && descending && directoryTree) {
    const reverse = (node) => {
      node.children.reverse();
      node.children.forEach(reverse);
    };
    reverse(directoryTree);
    directoryRows = tree.flatten(directoryTree, collapsedDirectories);
  }
  const visible = directoryRows
    .filter((entry) => entry.kind === "worktree")
    .map((entry) => entry.worktree);
  return { filtered, directoryRows, visible };
}

export function renderTreeRows(
  directoryRows,
  { selected, collapsed, disabled, cancelled },
) {
  const indentation = (depth) =>
    '<span class="tree-indent" aria-hidden="true"></span>'.repeat(
      Math.min(depth, 12),
    );
  return directoryRows
    .map((entry) => {
      if (entry.kind === "directory") {
        const node = entry.node;
        const expanded = !collapsed.has(node.path);
        const count = `${node.descendants.length} ${node.descendants.length === 1 ? "worktree" : "worktrees"}`;
        return `<tr class="directory-row" data-directory-path="${esc(node.path)}" aria-level="${entry.depth + 1}" aria-expanded="${expanded}"><td colspan="3" class="directory-cell"><div class="directory-line">${indentation(entry.depth)}<button class="directory-toggle" data-toggle-directory="${esc(node.path)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(node.path)}">${icon(expanded ? "chevron-down" : "chevron-right")}${icon("folder")}<span title="${esc(node.path)}">${esc(entry.label)}</span></button><span class="directory-count">${count}</span></div></td><td class="action-cell"><button class="row-action folder-delete" data-folder-delete="${esc(node.path)}" title="Delete matching worktrees in this group; keep this folder" ${disabled ? "disabled" : ""}>Delete…</button></td></tr>`;
      }
      const w = entry.worktree;
      const leaf = entry.label.split("/").pop();
      const prefix = entry.label.slice(0, -leaf.length);
      const pathLabel = `${prefix ? `<span class="path-chain">${esc(prefix)}</span>` : ""}<span class="path-basename">${esc(leaf)}</span>`;
      const context = w.pending
        ? cancelled
          ? "Scan incomplete"
          : "Checking…"
        : `${w.missing ? "Missing checkout · " : w.empty ? "Empty checkout · " : ""}${branchName(w)}${w.repo ? ` · ${w.repo}` : ""}`;
      return `<tr class="worktree-row${selected.has(w.id) ? " selected" : ""}${w.pending ? " pending-row" : ""}" data-id="${esc(w.id)}" data-path="${esc(w.path)}" aria-level="${entry.depth + 1}" aria-selected="${selected.has(w.id)}"><td class="branch-cell"><div class="tree-worktree-line">${indentation(entry.depth)}${icon("branch")}<div class="branch-copy"><span class="worktree-path" title="${esc(w.path)}" aria-label="${esc(w.path)}"><span class="path-parent">${esc(entry.pathPrefix.replace(/\/$/, "") + "/")}</span><span class="path-leaf">${pathLabel}</span></span><span class="worktree-context" title="${esc(context)}">${esc(context)}</span></div></div></td><td class="activity-cell" title="${esc(fullDate(w.activityAt))}">${ago(w.activityAt)}</td><td class="size-cell">${w.pending || w.missing ? "—" : size(w.sizeBytes)}</td><td class="action-cell"><div class="row-actions"><button class="row-action" data-delete="${esc(w.id)}" aria-label="Delete ${esc(w.path)}" ${disabled ? "disabled" : ""}>Delete</button><button class="icon-button row-menu" data-worktree-menu="${esc(w.id)}" aria-label="Actions for ${esc(w.path)}" title="Worktree actions">${icon("more")}</button></div></td></tr>`;
    })
    .join("");
}
