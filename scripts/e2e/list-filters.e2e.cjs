"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { scenario, assert } = require("./harness.cjs");
const { select, machine } = require("./setup-helpers.cjs");

async function choose(t, id, value) {
  const index = await t.evaluate(
    (id, value) =>
      [...document.querySelector(id).options].findIndex(
        (o) => o.value === value,
      ),
    id,
    value,
  );
  assert.ok(index >= 0, `${id} offers ${value}`);
  await select(t, id, index);
  assert.equal(await t.value(id), value);
}
const names = (t) =>
  t.evaluate(() =>
    [...document.querySelectorAll(".worktree-row")]
      .map((r) => r.dataset.path.split("/").pop())
      .sort(),
  );

scenario({
  name: "state and last-used filters",
  timeout: 120,
  setup(f) {
    const r = f.repository("projects/repo", { hoursOld: 24000 });
    const paths = {},
      expected = {};
    const add = (name, kind, options = {}) => {
      const row = r.worktree(name, options);
      paths[name] = row.path;
      (expected[kind] ||= []).push(name);
      return row;
    };
    for (const [name, days] of [
      ["recent", 3],
      ["week", 8],
      ["month", 31],
      ["quarter", 91],
      ["year", 366],
    ])
      add(name, "Merged", { hoursOld: days * 24 });
    add("new", "New", { hoursOld: 0 });
    add("not-merged", "Not merged", { commits: 1 });
    add("changed", "Changed files", { modified: true });
    add("ignored", "Ignored files", {
      ignored: { "debug.log": "build output" },
    });
    add("locked", "Locked", { locked: true });
    add("detached", "Detached", { detached: true });
    add("missing", "Folder missing", { missing: true });
    const empty = add("empty", "Empty folder");
    for (const name of fs.readdirSync(empty.path))
      fs.rmSync(path.join(empty.path, name), { recursive: true, force: true });
    const unchecked = add("unchecked", "Unchecked files");
    f.git(unchecked.path, "update-index", "--assume-unchanged", "README.md");
    add("protected", "Protected branch name", { branch: "develop" });
    const nested = add("nested", "Nested repository");
    f.repository(path.join(nested.path, "child"), { remote: false });
    const sub = f.repository("outside/sub", { remote: false });
    const modules = add("modules", "Submodules");
    f.git(modules.path, "submodule", "add", "-q", sub.path, "module");
    r.commit("Submodule", { where: modules.path, files: { marker: "module" } });
    const refs = add("refs", "Refs of its own");
    f.git(refs.path, "update-ref", "refs/worktree/keep", r.head());
    const broken = add("broken", "Cannot be deleted");
    f.write(
      path.join(broken.path, ".git"),
      `gitdir: ${f.path("absent-metadata")}\n`,
    );
    const op = f.repository("projects/operation-repo", {
      files: { conflict: "base\n" },
    });
    const base = op.head();
    op.commit("upstream", { files: { conflict: "upstream\n" } });
    const operation = op.worktree("operation", { from: base });
    op.commit("topic", {
      where: operation.path,
      files: { conflict: "topic\n" },
    });
    assert.equal(
      f.run("git", ["-C", operation.path, "merge", "main"]).status,
      1,
    );
    paths.operation = operation.path;
    expected["Unfinished Git operation"] = ["operation"];
    const host = f.host("fixture-host");
    f.repository(host.relative("projects", "repo")).worktree("remote-merged");
    f.preferences({
      hosts: [{ host: host.name, root: host.root, label: "Fixture host" }],
      hostFilter: "",
    });
    return { paths, expected };
  },
  launches: [
    async (t) => {
      await t.settled();
      await t.click("#sort-direction");
      for (const id of ["state-filter", "age-filter", "scan-options-button"]) {
        await t.press("Tab");
        assert.equal(
          await t.evaluate((id) => document.activeElement.id, id),
          id,
        );
      }
      await t.step(
        "every state option counts and shows exactly its rows",
        async () => {
          const options = await t.evaluate(() =>
            [...document.querySelector("#state-filter").options].map(
              (o) => o.textContent,
            ),
          );
          assert.deepEqual(options, [
            "Any state",
            ...Object.entries(t.world.expected)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([kind, rows]) => `${kind} (${rows.length})`),
          ]);
          for (const [kind, rows] of Object.entries(t.world.expected)) {
            await choose(t, "#state-filter", kind);
            assert.deepEqual(await names(t), [...rows].sort(), kind);
            assert.equal(await t.attribute("#state-filter", "class"), "active");
            assert.match(
              await t.text("#visible-count"),
              new RegExp(`^${rows.length} of `),
            );
          }
          await choose(t, "#state-filter", "");
        },
      );
      await t.step(
        "every age option, combined with state, search and repository",
        async () => {
          await choose(t, "#state-filter", "Merged");
          for (const [days, expected] of [
            ["7", ["week", "month", "quarter", "year"]],
            ["30", ["month", "quarter", "year"]],
            ["90", ["quarter", "year"]],
            ["365", ["year"]],
          ]) {
            await choose(t, "#age-filter", days);
            assert.deepEqual(await names(t), expected.sort());
          }
          await choose(t, "#age-filter", "30");
          await t.fill("#search", "year");
          assert.deepEqual(await names(t), ["year"]);
          await t.click('[data-view="recommended"]');
          assert.deepEqual(await names(t), ["year"]);
          await t.click("#repo-list .repo-item");
          // The first repository is operation-repo, which has no recommendations.
          assert.deepEqual(await names(t), []);
          await t.click("#repo-list .repo-item:last-child");
          assert.deepEqual(await names(t), ["year"]);
          await t.click('[data-view="all"]');
          assert.deepEqual(await names(t), ["year"]);
          await t.fill("#search", "");
          await choose(t, "#age-filter", "");
        },
      );
      await t.step(
        "filters keep row elements and ticks; Escape clears only ticks",
        async () => {
          await t.evaluate(() => {
            window.filterRows = new Map(
              [...document.querySelectorAll(".worktree-row")].map((r) => [
                r.dataset.id,
                r,
              ]),
            );
          });
          await t.click(await t.row(t.world.paths.recent));
          await t.click(await t.row(t.world.paths.year));
          await choose(t, "#age-filter", "30");
          assert.match(
            await t.text("#selection-label"),
            /2 worktrees selected · 1 not shown/,
          );
          await t.click("#remove-selected");
          assert.equal(await t.count(".cleanup-item"), 2);
          const review = await t.text("#cleanup-list");
          assert.ok(
            review.includes(t.world.paths.recent) &&
              review.includes(t.world.paths.year),
          );
          assert.match(await t.text("#cleanup-total"), /1 not shown/);
          await t.click("#cleanup-cancel");
          await choose(t, "#age-filter", "");
          assert.equal(
            await t.evaluate(() =>
              [...document.querySelectorAll(".worktree-row")].every(
                (r) => window.filterRows.get(r.dataset.id) === r,
              ),
            ),
            true,
          );
          await t.click("#search");
          await t.press("Down");
          assert.match(await t.focused(), /worktree-grid/);
          await t.press("Escape");
          assert.equal(await t.visible("#selection-bar"), false);
          assert.equal(await t.value("#state-filter"), "Merged");
          await t.click(await t.row(t.world.paths.recent));
          await t.click(await t.row(t.world.paths.year));
          await choose(t, "#age-filter", "30");
          await t.click("#remove-selected");
          assert.equal(await t.count(".cleanup-item"), 2);
          await t.click("#cleanup-confirm");
          await t.settled();
          for (const name of ["recent", "year"])
            assert.equal(t.fixture.exists(t.world.paths[name]), false);
          assert.equal(t.fixture.exists(t.world.paths.week), true);
        },
      );
      await t.step(
        "empty filters clear together with a search and announce once",
        async () => {
          await t.fill("#search", "no-such-worktree");
          assert.equal(
            await t.text("#empty-state h2"),
            "No worktrees match these filters",
          );
          assert.match(
            await t.text("#empty-state p"),
            /State: Merged.*Last active: not for a month.*Search:/,
          );
          assert.equal(await t.count("#empty-state button"), 1);
          await t.click("[data-clear-filters]");
          assert.equal(await t.value("#search"), "");
          assert.equal(await t.value("#state-filter"), "");
          assert.equal(await t.value("#age-filter"), "");
          await t.pause(500);
          await t.evaluate(() => {
            window.filterAnnouncements = [];
            new MutationObserver(() =>
              window.filterAnnouncements.push(
                document.querySelector("#announcement").textContent,
              ),
            ).observe(document.querySelector("#announcement"), {
              childList: true,
              subtree: true,
            });
          });
          await choose(t, "#state-filter", "Changed files");
          await t.until(
            async () =>
              (await t.js("window.filterAnnouncements")).includes(
                "1 worktree matches.",
              ),
            "filter announcement",
          );
          await t.pause(500);
          assert.deepEqual(await t.js("window.filterAnnouncements"), [
            "1 worktree matches.",
          ]);
          await choose(t, "#age-filter", "365");
          assert.equal(await t.count(".worktree-row"), 0);
          await t.click("[data-clear-filters]");
          await t.fill("#search", "no-such-worktree");
          assert.equal(await t.text("#empty-state button"), "Clear filter");
          await t.click("[data-clear-filter]");
        },
      );
      await t.step(
        "refresh and machine switches keep filters, and deletion keeps a zero choice",
        async () => {
          await choose(t, "#state-filter", "Merged");
          await choose(t, "#age-filter", "30");
          await machine(t, "fixture-host");
          assert.equal(await t.value("#state-filter"), "Merged");
          assert.equal(await t.value("#age-filter"), "30");
          await machine(t, "");
          await t.click("#refresh-button");
          await t.settled();
          assert.deepEqual(await names(t), ["month", "quarter"]);
          await t.click('[data-view="recommended"]');
          assert.match(
            await t.attribute("#cleanup-button", "title"),
            /2 worktrees recommended shown in this view/,
          );
          await t.click("#cleanup-button");
          assert.equal(await t.count(".cleanup-item"), 2);
          assert.match(
            await t.text("#cleanup-total"),
            /Only what the list is showing/,
          );
          await t.click("#cleanup-confirm");
          await t.settled();
          assert.equal(t.fixture.exists(t.world.paths.week), true);
          await choose(t, "#age-filter", "");
          await t.click("#cleanup-button");
          await t.click("#cleanup-confirm");
          await t.settled();
          assert.equal(await t.value("#state-filter"), "Merged");
          assert.equal(
            await t.text("#state-filter option:checked"),
            "Merged (0)",
          );
          assert.match(await t.text("#empty-state p"), /State: Merged/);
          await t.click("#refresh-button");
          await t.settled();
          assert.equal(
            await t.text("#state-filter option:checked"),
            "Merged (0)",
          );
        },
      );
    },
    async (t) => {
      await t.settled();
      assert.equal(await t.value("#state-filter"), "");
      assert.equal(await t.value("#age-filter"), "");
    },
  ],
});
