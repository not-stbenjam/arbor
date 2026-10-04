const test = require("node:test");
const assert = require("node:assert/strict");
const tree = require("./worktree-tree.js");
const w = (path, extra = {}) => ({ id: path, path, canRemove: true, ...extra });
test("physical tree includes ancestors and separates repositories from paths", () => {
  const root = tree.build(
    [
      w("/home/me/projects/one", { repo: "same" }),
      w("/home/me/scratch/two", { repo: "same" }),
    ],
    "/home/me",
  );
  const rows = tree.flatten(root);
  assert.deepEqual(
    rows.map((r) => (r.kind === "directory" ? r.node.path : r.worktree.path)),
    [
      "/home/me",
      "/home/me/projects",
      "/home/me/projects/one",
      "/home/me/scratch",
      "/home/me/scratch/two",
    ],
  );
  assert.equal(
    tree
      .flatten(root, new Set(["/home/me/projects"]))
      .filter((r) => r.kind === "worktree").length,
    1,
  );
});
test("folder cleanup includes descendants but never a sibling prefix or ordinary repository", () => {
  const values = [
    w("/work/foo/a"),
    w("/work/foo/deep/b", { canRemove: false, canDiscard: true }),
    w("/work/foo/keep", { canRemove: false, blockers: ["Nested repository"] }),
    w("/work/foobar/c"),
    w("/work/foo/main", { main: true }),
    w("/work/foo/bare", { bare: true }),
  ];
  const result = tree.cleanup(values, "/work/foo/");
  assert.deepEqual(
    result.removable.map((w) => w.path),
    ["/work/foo/a", "/work/foo/deep/b"],
  );
  assert.deepEqual(
    result.kept.map((w) => w.path),
    ["/work/foo/keep"],
  );
  assert.equal(result.all.length, 3);
});
test("pending rows cannot be removed and outside-root paths retain real ancestors", () => {
  const root = tree.build([w("/a/one", { pending: true }), w("/b/two")], "/a");
  assert.equal(root.path, "/");
  assert.deepEqual(tree.cleanup(root.descendants, "/a").removable, []);
  assert.equal(tree.cleanup(root.descendants, "/a").kept.length, 1);
});
test("nested worktree path remains a leaf entry alongside descendant directory groups", () => {
  const rows = tree.flatten(
    tree.build([w("/work/one"), w("/work/one/nested/two")], "/work"),
  );
  assert.deepEqual(
    rows.filter((r) => r.kind === "worktree").map((r) => r.worktree.path),
    ["/work/one", "/work/one/nested/two"],
  );
});
