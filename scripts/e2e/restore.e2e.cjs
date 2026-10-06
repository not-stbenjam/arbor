"use strict";
const { scenario, assert } = require("./harness.cjs");
const { registered } = require("./list-helpers.cjs");

async function deleteOne(t, target) {
  t.answer(1);
  await t.click(`${await t.row(target)} [data-delete]`);
  await t.until(() => !t.fixture.exists(target), "deleted folder");
  await t.settled();
  await t.until(() => t.exists(".toast-undo"), "Undo offered");
}
async function restored(t, target) {
  await t.until(
    async () =>
      t.fixture.exists(target) &&
      (await t.exists(`tr[data-path=${JSON.stringify(target)}]`)),
    "checkout and row put back",
  );
  await t.settled();
  assert.equal(registered(t, t.world.repo, target), true);
  assert.equal(t.fixture.read(`${target}/README.md`), t.world.contents);
  assert.equal(t.fixture.git(target, "status", "--porcelain"), "");
}
scenario({
  name: "restore deleted checkouts",
  size: [850, 560],
  setup(f) {
    const repo = f.repository("projects/repo");
    const one = repo.worktree("one"),
      two = repo.worktree("two");
    f.preferences();
    return {
      repo: repo.path,
      one: one.path,
      two: two.path,
      contents: f.read(`${one.path}/README.md`),
    };
  },
  launches: [
    async (t) => {
      await t.settled();
      await t.step(
        "delete two and Undo restores folders, files, registrations and rows without a rescan",
        async () => {
          await t.click("#select-all");
          await t.click("#remove-selected");
          await t.until(
            () => t.js("document.querySelector('#cleanup-dialog').open"),
            "review",
          );
          await t.click("#cleanup-confirm");
          await t.until(
            () =>
              !t.fixture.exists(t.world.one) && !t.fixture.exists(t.world.two),
            "both deleted",
          );
          await t.settled();
          await t.until(() => t.exists(".toast-undo"), "Undo");
          assert.match(
            await t.text("#toast-region"),
            /^Deleted 2 worktrees · About .+ recovered\.\s*Undo$/,
          );
          for (const target of [t.world.one, t.world.two])
            assert.equal(registered(t, t.world.repo, target), false);
          await t.screenshot("notice-with-undo");
          await t.click(".toast-undo");
          for (const target of [t.world.one, t.world.two])
            await restored(t, target);
          await t.until(
            async () =>
              (await t.text("#toast-region")) === "Put back 2 worktrees.",
            "Undo result",
          );
          assert.equal(
            t.fixture
              .cliCalls()
              .filter(
                (args) => args[0] === "list" && !args.includes("--target-only"),
              ).length,
            1,
          );
          await t.click('[aria-label="Dismiss notification"]');
        },
      );
      await t.step("delete again and keep a persistent history", async () => {
        await deleteOne(t, t.world.one);
        await t.click('[aria-label="Dismiss notification"]');
      });
    },
    async (t) => {
      await t.settled();
      await t.step(
        "Recently deleted survives restart and refuses an occupied destination",
        async () => {
          await t.menu("File", "Recently Deleted…");
          await t.until(() => t.exists("[data-restore]"), "saved deletion");
          assert.equal(await t.text("#restore-title"), "Recently deleted");
          assert.match(
            await t.text("#restore-content"),
            /one · repo · This computer/,
          );
          await t.screenshot("recently-deleted");
          t.fixture.write(`${t.world.one}/someone-elses-file.txt`, "keep this");
          await t.click("[data-restore]");
          await t.until(
            async () => /already exists/.test(await t.text(".restore-error")),
            "restore refusal beside entry",
          );
          assert.equal(
            t.fixture.read(`${t.world.one}/someone-elses-file.txt`),
            "keep this",
          );
          assert.equal(registered(t, t.world.repo, t.world.one), false);
          assert.equal((await t.js("window.arbor.listDeletions()")).length, 1);
          // Remove only the fixture obstruction to retry the same saved deletion.
          t.fixture.run("rm", ["-r", t.world.one]);
          await t.zoom(1.75);
          assert.equal(
            await t.js("document.activeElement.textContent"),
            "Restore",
          );
          await t.press("Enter");
          await restored(t, t.world.one);
          await t.until(
            async () =>
              (await t.text("#restore-content")) ===
              "Nothing deleted in the last 30 days.",
            "empty history",
          );
          await t.press("Escape");
          await t.zoom(1);
          await t.click('[aria-label="Dismiss notification"]');
        },
      );
      await t.step(
        "Undo plainly says that discarded files did not come back",
        async () => {
          t.fixture.write(`${t.world.two}/README.md`, "discarded local work\n");
          await t.click("#refresh-button");
          await t.settled();
          // Settle waits for acceptance too through the visible changed-file state.
          await t.until(
            async () =>
              /changed file/.test(await t.text(await t.row(t.world.two))),
            "changed row",
          );
          await deleteOne(t, t.world.two);
          await t.click(".toast-undo");
          await restored(t, t.world.two);
          await t.until(
            async () =>
              (await t.text("#toast-region")).includes(
                "Put back 1 worktree. The uncommitted files it had were discarded and are not back.",
              ),
            "discard warning",
          );
        },
      );
    },
  ],
});
