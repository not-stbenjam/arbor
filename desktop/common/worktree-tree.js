(function (root, factory) {
  const helpers = factory();
  if (typeof module === "object" && module.exports) module.exports = helpers;
  else root.ArborTree = helpers;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
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
  function build(worktrees, scanRoot) {
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
      name: path.split("/").pop() || "/",
      children: [],
      worktree: null,
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
      nodes.get(path).worktree = worktree;
    }
    function aggregate(node) {
      node.children.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
      node.descendants = [
        ...(node.worktree ? [node.worktree] : []),
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
      const group = isRoot || node.children.length > 0 || !node.worktree;
      if (group) {
        result.push({ kind: "directory", node, depth });
        if (collapsed.has(node.path)) return;
      }
      if (node.worktree)
        result.push({
          kind: "worktree",
          worktree: node.worktree,
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
  return Object.freeze({
    normalize,
    parent,
    contains,
    linked,
    descendants,
    cleanup,
    build,
    flatten,
  });
});
