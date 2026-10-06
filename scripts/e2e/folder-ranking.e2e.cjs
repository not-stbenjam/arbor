"use strict";
const { scenario, assert } = require("./harness.cjs");
scenario({
  name: "folder-ranking",
  setup(f) {
    const repo = f.repository("projects/repo");
    const entries = [
      ["one", "a/one", 6000, 96],
      ["two", "a/two", 6000, 72],
      ["large", "z/deep/large", 10000, 120],
      ["small", "z/deep/small", 100, 24],
    ];
    for (const [name, at, bytes, hoursOld] of entries)
      repo.worktree(name, { at: `projects/${at}`, files: { payload: bytes }, hoursOld });
    const host = f.host("build");
    f.repository(host.relative("projects/repo")).worktree("remote", { files: { payload: 11000 }, hoursOld: 48 });
    f.preferences({ hosts: [{ host: "build", root: host.root }] });
  },
  launches: [async (t) => {
    await t.settled();
    const order = () => t.texts(".path-basename");
    await t.click('[data-sort="size"]');
    assert.deepEqual(await order(), ["remote", "large", "small", "one", "two"]);
    assert.deepEqual(await t.texts(".host-row .directory-toggle span"), ["build", "This computer"]);
    await t.screenshot("2-largest-first");
    await t.click("#sort-direction");
    assert.deepEqual(await order(), ["one", "two", "small", "large", "remote"]);
    await t.click('[data-sort="activity"]');
    assert.deepEqual(await order(), ["small", "large", "two", "one", "remote"]);
    await t.click("#sort-direction");
    assert.deepEqual(await order(), ["large", "small", "one", "two", "remote"]);
    await t.click('[data-sort="path"]');
    assert.deepEqual(await order(), ["one", "two", "large", "small", "remote"]);
  }],
});
