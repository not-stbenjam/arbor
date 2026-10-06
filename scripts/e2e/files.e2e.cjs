"use strict";
const { scenario, assert } = require("./harness.cjs");
const fs = require("node:fs");
const path = require("node:path");

scenario({
  name: "what a worktree holds locally and over SSH",
  size: [850, 560],
  setup(f) {
    const host = f.host("files-host");
    const trees = [];
    for (const [root, name, connection] of [
      ["projects", "local-work", ""],
      [host.root, "remote-work", host.name],
    ]) {
      const repo = f.repository(`${root}/repo`);
      const tree = repo.worktree(name);
      f.write(`${tree.path}/README.md`, "modified\n");
      f.write(`${tree.path}/notes.txt`, "notes\n");
      f.write(`${tree.path}/.gitignore`, "ignored/\n");
      f.write(`${tree.path}/ignored/first`, "123");
      f.write(`${tree.path}/ignored/second`, "45678");
      f.repository(`${tree.path}/nested`, { remote: false });
      trees.push({ path: tree.path, name, host: connection, repo: repo.path });
    }
    f.preferences({
      hosts: [{ host: host.name, name: "Files host", root: host.root }],
    });
    return { trees };
  },
  launches: [
    async (t) => {
      await t.settled();
      const { size } = await import("../../desktop/renderer/presentation.mjs");
      async function verify(tree) {
        await t.until(
          async () => / items?$/.test(await t.text("#files-total")),
          "the inventory to load",
        );
        assert.equal(await t.text("#files-title"), `Show Files — ${tree.name}`);
        const cli = t.fixture.cli(
          "files",
          tree.path,
          "--repo",
          tree.repo,
          "--json",
          ...(tree.host ? ["--host", tree.host] : []),
        );
        assert.equal(cli.status, 0, cli.stderr);
        const report = JSON.parse(cli.stdout);
        for (const [kind, file] of [
          ["changes", "README.md"],
          ["changes", "notes.txt"],
          ["ignored", "ignored"],
          ["nested", "nested"],
        ]) {
          const entry = report.entries.find(
            (entry) => entry.kind === kind && entry.path === file,
          );
          assert.ok(entry, `${kind}: ${file}`);
          if (kind === "changes")
            assert.equal(
              entry.sizeBytes,
              fs.statSync(path.join(tree.path, file)).size,
            );
          if (kind === "ignored") {
            assert.equal(entry.sizeBytes, 8);
            assert.equal(entry.files, 2);
          }
          if (kind === "nested") {
            let bytes = 0,
              files = 0;
            const walk = (folder) => {
              for (const item of fs.readdirSync(folder, {
                withFileTypes: true,
              })) {
                const disk = path.join(folder, item.name);
                if (item.isDirectory()) walk(disk);
                else if (item.isFile()) {
                  bytes += fs.statSync(disk).size;
                  files++;
                }
              }
            };
            walk(path.join(tree.path, file));
            assert.equal(entry.sizeBytes, bytes);
            assert.equal(entry.files, files);
          }
          const lines = await t.texts(".files-group li");
          assert.ok(
            lines.some(
              (text) =>
                text.includes(file) && text.includes(size(entry.sizeBytes)),
            ),
            `${file} size shown`,
          );
        }
        const count = Object.values(report.counts).reduce((a, b) => a + b, 0);
        assert.equal(await t.text("#files-total"), `${count} items`);
        assert.equal(
          await t.count(
            "#files-dialog [data-delete]:not([hidden]), #files-dialog .button-danger:not([hidden])",
          ),
          0,
        );
        assert.match(await t.text("#files-lead"), /discards these files and Git data/);
        return report;
      }
      for (const tree of t.world.trees) {
        await t.step(
          `${tree.host || "this computer"}: row menu and disk agree`,
          async () => {
            const row = await t.row(tree.path);
            const menu = await t.contextMenu(`${row} .branch-cell`);
            assert.ok(
              menu.find((item) => item.label === "Show Files…").enabled,
            );
            await t.chooseMenu("Show Files…");
            await verify(tree);
            assert.equal(await t.focused(), "h2#files-title");
            if (!tree.host) {
              for (const theme of ["light", "dark"]) {
                await t.evaluate(
                  (theme) => (document.documentElement.dataset.theme = theme),
                  theme,
                );
                await t.screenshot(`files-${theme}`);
              }
              const human = t.fixture.cli(
                "files",
                tree.path,
                "--repo",
                tree.repo,
              );
              assert.equal(human.status, 0, human.stderr);
              const folder = process.env.ARBOR_E2E_ARTIFACTS;
              if (folder) {
                fs.writeFileSync(path.join(folder, "human.txt"), human.stdout);
                fs.writeFileSync(
                  path.join(folder, "dialog.txt"),
                  await t.text("#files-dialog"),
                );
              }
              await t.zoom(1.75);
              await t.point("#files-close");
              assert.equal(await t.visible("#files-close"), true);
              await t.zoom(1);
            }
            await t.press("Escape");
            assert.equal(
              await t.js("document.querySelector('#files-dialog').open"),
              false,
            );
            const beforeEnter = t.native.menus;
            await t.press("Enter");
            await t.until(
              () => t.native.menus > beforeEnter,
              "Enter opens the row menu",
            );
            await t.chooseMenu("Show Files…");
            await verify(tree);
            await t.press("Escape");
            // The ellipsis uses the same native menu.
            const before = t.native.menus;
            await t.click(`${row} [data-worktree-menu]`);
            await t.until(() => t.native.menus > before, "ellipsis opens");
            await t.chooseMenu("Show Files…");
            await verify(tree);
            await t.press("Escape");
          },
        );
      }
      await t.step(
        "each unclean review row opens the inventory above its unchanged review",
        async () => {
          await t.click("#select-all");
          await t.click("#remove-selected");
          await t.until(
            () => t.js("document.querySelector('#cleanup-dialog').open"),
            "review opens",
          );
          for (const tree of t.world.trees) {
            const row = await t.worktree(tree.path);
            await t.click(`[data-files='${row.id}']`);
            await verify(tree);
            assert.equal(
              await t.js("document.querySelector('#cleanup-dialog').open"),
              true,
            );
            await t.press("Escape");
            assert.equal(
              await t.attribute(`[data-files='${row.id}']`, "type"),
              "button",
            );
            assert.equal(
              await t.js("document.activeElement.hasAttribute('data-files')"),
              true,
            );
          }
          await t.click("#cleanup-cancel");
          assert.equal(
            t.fixture.cliCalls().filter((args) => args[0] === "remove").length,
            0,
          );
          for (const tree of t.world.trees)
            assert.ok(t.fixture.exists(tree.path));
          assert.ok(
            t.fixture.connections().every((host) => host === "files-host"),
          );
        },
      );
    },
  ],
});
