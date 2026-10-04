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

// Pure tree projection and markup. No DOM, IPC, timers, or mutable view state.
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
    directoryRows = rowsFor(filtered, root, hostFilter);
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
  return directoryRows
    .map((entry) => {
      if (entry.kind === "host") {
        const expanded = !collapsed.has(entry.key);
        return `<tr class="directory-row host-row" data-host="${esc(entry.host)}" aria-level="1" aria-expanded="${expanded}"><td colspan="4" class="directory-cell"><div class="directory-line"><button class="directory-toggle" data-toggle-directory="${esc(entry.key)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(entry.label)}">${icon(expanded ? "chevron-down" : "chevron-right")}${icon(entry.host ? "server" : "monitor")}<span>${esc(entry.label)}</span></button><span class="directory-count">${entry.descendants.length} ${entry.descendants.length === 1 ? "worktree" : "worktrees"}</span></div></td></tr>`;
      }
      if (entry.kind === "directory") {
        const node = entry.node;
        const key = node.key || node.path;
        const expanded = !collapsed.has(key);
        const count = `${node.descendants.length} ${node.descendants.length === 1 ? "worktree" : "worktrees"}`;
        return `<tr class="directory-row" data-directory-path="${esc(node.path)}" data-host="${esc(node.host || "")}" aria-level="${entry.depth + 1}" aria-expanded="${expanded}"><td colspan="3" class="directory-cell"><div class="directory-line">${indentation(entry.depth)}<button class="directory-toggle" data-toggle-directory="${esc(key)}" aria-expanded="${expanded}" aria-label="${expanded ? "Collapse" : "Expand"} ${esc(node.path)}">${icon(expanded ? "chevron-down" : "chevron-right")}${icon("folder")}<span title="${esc(node.path)}">${esc(entry.label)}</span></button><span class="directory-count">${count}</span></div></td><td class="action-cell"><div class="row-actions"><button class="row-action folder-delete" data-folder-delete="${esc(key)}" title="Delete matching worktrees in this group; keep this folder" ${disabled ? "disabled" : ""}>Delete…</button></div></td></tr>`;
      }
      const w = entry.worktree;
      const rowDisabled = disabled || !canDelete(w);
      const leaf = entry.label.split("/").pop();
      const prefix = entry.label.slice(0, -leaf.length);
      const pathLabel = `${prefix ? `<span class="path-chain">${esc(prefix)}</span>` : ""}<span class="path-basename">${esc(leaf)}</span>`;
      const context = w.pending
        ? cancelled
          ? "Scan incomplete"
          : "Checking…"
        : `${w.missing ? "Missing checkout · " : w.empty ? "Empty checkout · " : ""}${branchName(w)}${w.repo ? ` · ${w.repo}` : ""}`;
      return `<tr class="worktree-row${selected.has(w.id) ? " selected" : ""}${w.pending ? " pending-row" : ""}" data-id="${esc(w.id)}" data-path="${esc(w.path)}" data-host="${esc(w.host || "")}" aria-level="${entry.depth + 1}" aria-selected="${selected.has(w.id)}"><td class="branch-cell"><div class="tree-worktree-line">${indentation(entry.depth)}${icon("branch")}<div class="branch-copy"><span class="worktree-path" title="${esc(w.path)}" aria-label="${esc(w.path)}"><span class="path-parent">${esc(entry.pathPrefix.replace(/\/$/, "") + "/")}</span><span class="path-leaf">${pathLabel}</span></span><span class="worktree-context" title="${esc(context)}">${esc(context)}</span></div></div></td><td class="activity-cell" title="${esc(fullDate(w.activityAt))}">${ago(w.activityAt)}</td><td class="size-cell">${w.pending || w.missing ? "—" : size(w.sizeBytes)}</td><td class="action-cell"><div class="row-actions"><button class="row-action" data-delete="${esc(w.id)}" aria-label="Delete ${esc(w.path)}" ${rowDisabled ? "disabled" : ""}>Delete</button><button class="icon-button row-menu" data-worktree-menu="${esc(w.id)}" aria-label="Actions for ${esc(w.path)}" title="Worktree actions">${icon("more")}</button></div></td></tr>`;
    })
    .join("");
}
