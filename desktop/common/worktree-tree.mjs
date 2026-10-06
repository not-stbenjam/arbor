// Pure directory-tree projection of worktree rows, shared by the renderer and
// its tests. Paths are POSIX: every scanned machine is macOS or Linux.
function normalize(path) {
  const parts = [];
  for (const part of String(path || "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}
function parent(path) {
  path = normalize(path);
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
function contains(folder, path) {
  folder = normalize(folder);
  path = normalize(path);
  return path === folder || folder === "/" || path.startsWith(folder + "/");
}
function linked(worktrees) {
  return worktrees.filter((w) => w && w.path && !w.main && !w.bare);
}
function scopedKey(host, path) {
  return host === undefined ? path : JSON.stringify([host, path]);
}
function repositoryKey(worktree) {
  return scopedKey(
    worktree.host,
    worktree.commonDir || worktree.repo || worktree.path,
  );
}
function activityTime(value) {
  if (typeof value !== "string" && typeof value !== "number") return NaN;
  const date = new Date(value);
  return date.getFullYear() >= 1971 ? date.valueOf() : NaN;
}
function filter(worktrees, options = {}) {
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  return linked(worktrees).filter(
    (w) =>
      (!options.repo || repositoryKey(w) === options.repo) &&
      (options.view !== "recommended" || w.recommended) &&
      (!options.stateFilter || options.kind?.(w) === options.stateFilter) &&
      (options.activityBefore === undefined ||
        activityTime(w.activityAt) <= options.activityBefore) &&
      (!query ||
        // What the row shows as its state is searchable with the rest, so
        // "ignored" or "merged" finds the rows that say so.
        [w.path, w.branch, w.repo, w.head, w.subject, w.host, options.state?.(w)].some(
          (value) =>
            String(value || "")
              .toLowerCase()
              .includes(query),
        )),
  );
}
function folderWorktrees(rows, path) {
  const entry = rows.find(
    (row) =>
      row.kind === "directory" && (row.node.key || row.node.path) === path,
  );
  return entry ? [...entry.node.descendants] : [];
}
function descendants(worktrees, path) {
  return linked(worktrees).filter((w) => contains(path, w.path));
}
function cleanup(worktrees, path) {
  const all = descendants(worktrees, path);
  return {
    all,
    removable: all.filter((w) => !w.pending && (w.canRemove || w.canDiscard)),
    kept: all.filter((w) => w.pending || (!w.canRemove && !w.canDiscard)),
  };
}
// Reuse the numeric collation rules across comparisons in a large folder.
const directoryOrder = new Intl.Collator(undefined, { numeric: true });
function build(worktrees, scanRoot, host) {
  worktrees = linked(worktrees);
  if (!worktrees.length) return null;
  let rootPath =
    typeof scanRoot === "string" && scanRoot.startsWith("/")
      ? normalize(scanRoot)
      : parent(worktrees[0].path);
  while (!worktrees.every((w) => contains(rootPath, w.path)))
    rootPath = parent(rootPath);
  const makeNode = (path) => ({
    path,
    key: scopedKey(host, path),
    host,
    name: path.split("/").pop() || "/",
    children: [],
    worktrees: [],
    descendants: [],
  });
  const root = makeNode(rootPath);
  const nodes = new Map([[rootPath, root]]);
  for (const worktree of worktrees) {
    const path = normalize(worktree.path);
    const missing = [];
    let cursor = path;
    while (!nodes.has(cursor)) {
      missing.push(cursor);
      cursor = parent(cursor);
    }
    for (const childPath of missing.reverse()) {
      const node = makeNode(childPath);
      nodes.get(parent(childPath)).children.push(node);
      nodes.set(childPath, node);
    }
    nodes.get(path).worktrees.push(worktree);
  }
  function aggregate(node) {
    node.children.sort((a, b) =>
      directoryOrder.compare(a.name, b.name),
    );
    node.descendants = [
      ...node.worktrees,
      ...node.children.flatMap(aggregate),
    ];
    return node.descendants;
  }
  aggregate(root);
  return root;
}
function flatten(root, collapsed = new Set(), compare) {
  if (!root) return [];
  const result = [];
  function visit(node, depth, isRoot) {
    const pathPrefix = parent(node.path);
    let label = isRoot ? node.path : node.name;
    // Retain the scan root and actual worktree boundaries, but compress
    // intermediate folders that offer no branching choice.
    while (!isRoot && !node.worktrees.length && node.children.length === 1) {
      node = node.children[0];
      label += "/" + node.name;
    }
    const group =
      isRoot || node.children.length > 0 || !node.worktrees.length;
    if (group) {
      result.push({ kind: "directory", node, depth, label });
      if (collapsed.has(node.key)) return;
    }
    const registrations = [...node.worktrees];
    if (compare) registrations.sort((a, b) => compare([a], [b]));
    for (const worktree of registrations)
      result.push({
        kind: "worktree",
        worktree,
        label: group ? node.name : label,
        pathPrefix: group ? parent(node.path) : pathPrefix,
        depth: depth + (group ? 1 : 0),
        parent: group ? node.path : parent(node.path),
      });
    const children = [...node.children];
    if (compare)
      children.sort(
        (a, b) =>
          compare(a.descendants, b.descendants) ||
          a.name.localeCompare(b.name),
      );
    for (const child of children) visit(child, depth + 1, false);
  }
  visit(root, 0, true);
  return result;
}

export {
  normalize,
  parent,
  contains,
  linked,
  scopedKey,
  repositoryKey,
  filter,
  folderWorktrees,
  descendants,
  cleanup,
  build,
  flatten,
};
