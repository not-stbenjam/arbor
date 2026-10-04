const test = require("node:test");
const assert = require("node:assert/strict");
const tree = require("./worktree-tree.js");
const w = (path, extra = {}) => ({ id: path, path, canRemove: true, ...extra });
test("physical tree includes ancestors and separates repositories from paths", () => {
  const root = tree.build(
    [
      w("/home/me/projects/one", { repo: "same" }),
      w("/home/me/projects/three", { repo: "same" }),
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
      "/home/me/projects/three",
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
test("single-child directory chains compress without changing paths or cleanup scope", () => {
  const values = [
    w("/work/sessions/recent/aa/worktree"),
    w("/work/sessions/recent/bb/worktree"),
  ];
  const root = tree.build(values, "/work");
  const rows = tree.flatten(root);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["/work", "sessions/recent", "aa/worktree", "bb/worktree"],
  );
  assert.equal(rows[1].node.path, "/work/sessions/recent");
  assert.equal(rows[2].pathPrefix, "/work/sessions/recent");
  assert.equal(rows[2].worktree.path, values[0].path);
  assert.deepEqual(tree.folderWorktrees(rows, "/work/sessions/recent"), values);
  assert.deepEqual(
    tree
      .flatten(root, new Set(["/work/sessions/recent"]))
      .map((row) => row.label),
    ["/work", "sessions/recent"],
  );
});
test("folder deletion is limited to active search, repository, and recommended filters", () => {
  const values = [
    w("/work/folder/match-a", {
      repo: "shared",
      commonDir: "/repo/a",
      recommended: true,
    }),
    w("/work/folder/match-b", {
      repo: "shared",
      commonDir: "/repo/b",
      recommended: true,
    }),
    w("/work/folder/other", {
      repo: "shared",
      commonDir: "/repo/a",
      recommended: false,
    }),
    w("/work/folder/match-dirty", {
      repo: "shared",
      commonDir: "/repo/a",
      canRemove: false,
      canDiscard: true,
    }),
    w("/work/folder-prefix/match-sibling", {
      commonDir: "/repo/a",
      recommended: true,
    }),
  ];
  const cases = [
    [{ query: "MATCH" }, [0, 1, 3]],
    [{ repo: "/repo/a" }, [0, 2, 3]],
    [{ view: "recommended" }, [0, 1]],
    [{ query: "match", repo: "/repo/a" }, [0, 3]],
    [{ query: "match", repo: "/repo/a", view: "recommended" }, [0]],
  ];
  for (const [options, expected] of cases) {
    // Anchor at the folder so a singleton filtered group remains actionable.
    const root = tree.build(
      tree.filter(values.slice(0, 4), options),
      "/work/folder",
    );
    for (const collapsed of [new Set(), new Set(["/work/folder"])]) {
      const rows = tree.flatten(root, collapsed);
      assert.deepEqual(
        tree
          .folderWorktrees(rows, "/work/folder")
          .map((w) => w.path)
          .sort(),
        expected.map((index) => values[index].path).sort(),
        JSON.stringify(options),
      );
    }
  }
  const allRows = tree.flatten(tree.build(values, "/work"));
  assert.deepEqual(
    tree
      .folderWorktrees(allRows, "/work/folder")
      .map((w) => w.path)
      .sort(),
    values
      .slice(0, 4)
      .map((w) => w.path)
      .sort(),
  );
  assert.deepEqual(tree.folderWorktrees(allRows, "/work/missing"), []);
});
