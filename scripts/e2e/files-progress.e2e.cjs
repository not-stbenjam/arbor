"use strict";
const { scenario, assert } = require("./harness.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

scenario({
  name: "file inventory progress and cancellation",
  size: [1240, 800],
  timeout: 300,
  setup(f) {
    const host = f.host("progress-host");
    const local = f.repository("projects/repo", { ignore: ["build-*/"] });
    const remote = f.repository(`${host.root}/repo`, { ignore: ["build-*/"] });
    const trees = [local.worktree("large"), remote.worktree("remote-large")];
    const tiny = local.worktree("tiny");
    f.preferences({ hosts: [{host: host.name, name: "Progress host", root: host.root}] });
    return { trees, tiny, host: host.name };
  },
  launches: [async (t) => {
    await t.settled();
    const open = async (tree) => {
      const row = await t.row(tree.path);
      await t.contextMenu(`${row} .branch-cell`);
      await t.chooseMenu("Show what it holds…");
    };
    const done = () => t.until(async () => / items?$/.test(await t.text("#files-total")), "inventory replaces progress", 30000);
    const processes = (tree) => execFileSync("ps", ["-eo", "pid=,args="], {encoding: "utf8"})
      .split("\n").filter((line) => /arbor(?:-cli)? files /.test(line) && line.includes(tree.path));
    await t.step("a tiny inventory is immediate and has no delayed flash", async () => {
      await t.evaluate(() => {
        window.filesLoadingFrames = [];
        window.filesFrameWatch = setInterval(() => {
          window.filesLoadingFrames.push(document.querySelector("#files-progress").checkVisibility());
        }, 5);
      });
      await open(t.world.tiny);
      await done();
      await t.evaluate(() => clearInterval(window.filesFrameWatch));
      assert.equal(await t.js("window.filesLoadingFrames.some(Boolean)"), false, "tiny inventory never painted a bar");
      assert.equal(await t.visible("#files-progress"), false);
      await t.pause(200);
      assert.equal(await t.visible("#files-progress"), false);
      await t.press("Escape");
    });
    // Real files make the work observable without any product delay. Create
    // them after scanning so only the requested inventory walks this workload.
    for (const tree of t.world.trees) {
      for (let folder = 0; folder < 120; folder++) {
        const dir = path.join(tree.path, `build-${String(folder).padStart(3, "0")}`);
        fs.mkdirSync(dir);
        for (let file = 0; file < 2000; file++) fs.writeFileSync(path.join(dir, String(file)), "x");
      }
    }
    t.page.debugger.attach("1.3");
    await t.page.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    for (const tree of t.world.trees) {
      await t.step(`${tree.path}: stages, counts, replacement and cancellation`, async () => {
        await open(tree);
        await t.until(() => t.visible("#files-progress"), "visible progress");
        assert.equal(await t.attribute("#files-progress", "role"), "progressbar");
        assert.equal(await t.attribute("#files-dialog", "aria-busy"), "true");
        await t.until(async () => (await t.text("#files-status")) === "Looking through the folder…", "folder search");
        assert.equal(await t.attribute("#files-progress", "aria-valuenow"), null);
        assert.equal(await t.js("getComputedStyle(document.querySelector('#files-progress')).animationName"), "none");
        assert.match(await t.text("#files-count"), /[\d,]+ files/);
        await t.until(async () => (await t.text("#files-status")) === "Adding up sizes…", "size measurement");
        const max = Number(await t.attribute("#files-progress", "aria-valuemax"));
        assert.equal(max, 120);
        assert.ok(Number(await t.attribute("#files-progress", "aria-valuenow")) <= max);
        const loading = await t.js("document.querySelector('.files-results').getBoundingClientRect().height");
        await done();
        assert.equal(await t.visible("#files-progress"), false);
        assert.equal(await t.attribute("#files-dialog", "aria-busy"), "false");
        assert.equal(await t.js("document.querySelector('.files-results').getBoundingClientRect().height"), loading);
        assert.equal(await t.count(".files-group li"), 120);
        await t.press("Escape");
        await open(tree);
        await t.until(() => t.visible("#files-progress"), "progress before cancelling");
        assert.ok(processes(tree).length, "a real files process is running");
        await t.press("Escape");
        await t.until(() => processes(tree).length === 0, "local and remote files processes exit", 5000);
        assert.equal(await t.js("document.querySelector('#files-dialog').open"), false);
      });
    }
    await t.page.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    t.page.debugger.detach();
    if (process.env.ARBOR_E2E_ARTIFACTS) {
      for (const width of [1240, 850]) for (const zoom of [1, 1.5]) for (const theme of ["light", "dark"]) {
        await t.zoom(1);
        await t.resize(width, 800);
        await t.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await open(t.world.trees[0]);
        await t.zoom(zoom);
        await t.until(async () => await t.visible("#files-progress") && await t.text("#files-status") === "Looking through the folder…", "search for screenshot");
        await t.screenshot(`indeterminate-${theme}-${width}-${zoom}`);
        await t.until(async () => await t.text("#files-status") === "Adding up sizes…" && Number(await t.attribute("#files-progress", "aria-valuenow")) > 0, "measurement for screenshot");
        await t.screenshot(`filling-${theme}-${width}-${zoom}`);
        assert.equal(await t.visible("#files-close"), true);
        await done();
        await t.press("Escape");
      }
    }
  }],
});
