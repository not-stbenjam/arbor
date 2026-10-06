"use strict";
const { scenario, assert } = require("./harness.cjs");
const { open, close, layout } = require("./stress-helpers.cjs");
scenario({
  name: "layout at minimum and large sizes", timeout: 30,
  setup(f) {
    const r = f.repository("projects/repository-with-a-long-but-readable-name");
    r.worktree("merged-" + "m".repeat(100)); r.worktree("dirty",{modified:true});
    r.worktree("new",{hoursOld:0}); r.worktree("locked",{locked:true});
    r.worktree("missing",{missing:true}); r.worktree("detached",{detached:true});
    r.worktree("ignored", { ignored: { "debug.log": "local" } });
    const unchecked = r.worktree("unchecked");
    f.git(unchecked.path, "update-index", "--assume-unchanged", "README.md");
    r.worktree("protected", { branch: "develop" });
    f.preferences();
  },
  launches: [async t => {
    await t.settled();
    for (const theme of ["light","dark"]) {
      if (theme === "dark") await t.click("#theme-button");
      for (const [width,height] of [[850,560],[1600,1000]]) {
        await t.resize(width,height);
        // Small-window 200–300% failures live in bugs/zoom-sidebar.
        for (const zoom of (width === 850 ? [.5,1,1.5] : [.5,1,1.5,2,3])) {
          await t.zoom(zoom);
          await t.step(`${theme} ${width}x${height} at ${zoom*100}%`, async () => {
            assert.deepEqual(await layout(t), [], "list geometry");
            for (const [b,d] of [["#cleanup-button","#cleanup-dialog"],["#settings-button","#settings-dialog"],["#statistics-button","#statistics-dialog"],["#add-host","#machine-dialog"]]) {
              await open(t,b,d);
              assert.deepEqual(await layout(t,d), [], d);
              await close(t,b,d);
            }
          });
        }
        await t.zoom(1);
      }
    }
  }],
});
