"use strict";
const { scenario, assert } = require("./harness.cjs");
const { saved, scans, open, closed, machine, cached } = require("./setup-helpers.cjs");
scenario({ name: "hosts validation switching removal and statistics", timeout: 28,
  setup(f) {
    const host = f.host("workbox");
    const remote = f.repository(host.relative("projects/repo")).worktree("remote-tree").path;
    const local = f.repository("projects/repo").worktree("local-tree").path;
    f.preferences(); return { remote, local };
  }, launches: [async (t) => {
    await t.settled();
    await t.step("invalid SSH names never reach ssh; adding a fixture host scans it", async () => {
      await t.click("#add-host");
      await open(t, "machine-dialog");
      for (const host of ["-oProxyCommand", "two words", "a;echo", "user@host/dir"]) {
        await t.fill("#host-input", host);
        await t.click("#host-form button[type=submit]");
        assert.match(await t.text("#host-error"), /without spaces or options/);
        assert.deepEqual(t.fixture.connections(), []);
        assert.deepEqual(saved(t).hosts, []);
      }
      await t.fill("#host-input", "workbox");
      await t.fill("#host-name", "  Work laptop  ");
      await t.fill("#host-root", "~/projects");
      await t.click("#host-form button[type=submit]");
      await closed(t, "machine-dialog");
      await t.settled();
      assert.equal(await t.text("#machine-label"), "Work laptop");
      assert.equal(saved(t).hosts[0].name, "Work laptop");
      assert.match(await t.text(await t.row(t.world.remote)), /remote-tree/);
      assert.ok(t.fixture.connections().length >= 3);
      assert.ok(t.fixture.connections().every((host) => host === "workbox"));
      assert.equal(saved(t).hosts[0].root, "~/projects");
      await cached(t, t.world.remote);
    });
    await t.step("display names can be edited or cleared without another SSH scan", async () => {
      const calls = scans(t).length, connections = t.fixture.connections().length;
      await t.click("#machine-button");
      assert.match(await t.text("#host-menu"), /Work laptop/);
      await t.click("#host-menu [data-manage]");
      const name = '[data-host-name="workbox"]';
      assert.equal(await t.value(name), "Work laptop");
      assert.equal(await t.value("#host-name"), "");
      await t.fill(name, "Build server");
      await t.click("#host-input");
      await t.until(() => saved(t).hosts[0].name === "Build server", "display name saved");
      assert.equal(await t.text("#machine-label"), "Build server");
      assert.match(await t.text('#machine-list [data-host="workbox"]'), /Build server/);
      await t.fill(name, "");
      await t.click("#host-input");
      await t.until(() => saved(t).hosts[0].name === "workbox", "SSH address used as fallback");
      assert.equal(await t.text("#machine-label"), "workbox");
      assert.match(await t.text('#machine-list [data-host="workbox"]'), /workbox/);
      await t.press("Escape");
      assert.equal(scans(t).length, calls);
      assert.equal(t.fixture.connections().length, connections);
    });
    await t.step("switching filters existing rows without another scan", async () => {
      const calls = scans(t).length, connections = t.fixture.connections().length;
      await machine(t, "");
      assert.match(await t.text(await t.row(t.world.local)), /local-tree/);
      assert.equal((await t.rows()).filter((r) => !r.folder).length, 1);
      await machine(t, null);
      assert.equal((await t.rows()).filter((r) => !r.folder).length, 2);
      assert.equal(scans(t).length, calls);
      assert.equal(t.fixture.connections().length, connections);
      await machine(t, "workbox");
    });
    await t.step("remote deletion changes only the remote disk and remote totals", async () => {
      await t.click("#cleanup-button");
      await open(t, "cleanup-dialog");
      assert.match(await t.text("#cleanup-list"), /remote-tree/);
      await t.click("#cleanup-confirm");
      await t.until(() => !t.fixture.exists(t.world.remote), "remote folder deleted");
      await t.settled();
      assert.ok(t.fixture.exists(t.world.local));
      assert.equal(t.fixture.statistics(), null);
      const stats = JSON.parse(t.fixture.read("hosts/workbox/.config/arbor/statistics.json"));
      assert.equal(stats.removedWorktrees, 1);
      const removes = t.fixture.cliCalls().filter((args) => args[0] === "remove");
      assert.equal(removes.length, 1);
      assert.ok(removes[0].includes("--host") && removes[0].includes("workbox"));
      await t.click("#statistics-button");
      await t.until(() => t.text('[data-stat="removedWorktrees"]'), "remote totals");
      assert.equal(await t.text('[data-stat="removedWorktrees"]'), "1");
      assert.equal(await t.text(".statistics-scope"), "workbox");
      await t.press("Escape");
      await machine(t, "");
      await t.click("#statistics-button");
      await t.until(async () => /No cleanups yet/.test(await t.text("#statistics-content")), "empty local statistics");
      await t.press("Escape");
      await machine(t, null);
      await t.click("#statistics-button");
      await t.until(() => t.text('[data-stat="removedWorktrees"]'), "combined totals");
      assert.equal(await t.text('[data-stat="removedWorktrees"]'), "1");
      assert.equal(await t.text(".statistics-scope"), "All hosts");
      await t.press("Escape");
    });
    await t.step("duplicate hosts explain Settings; forgetting keeps Git data", async () => {
      await t.menu("File", "Add SSH Host…");
      await t.fill("#host-input", "workbox");
      await t.click("#host-form button[type=submit]");
      assert.match(await t.text("#host-error"), /already saved.*Settings/);
      await t.click('[data-forget-host="workbox"]');
      await t.until(() => saved(t).hosts.length === 0, "host forgotten on disk");
      assert.ok(t.fixture.exists("hosts/workbox/projects/repo/.git"));
      await t.press("Escape");
    });
  }, async (t) => {
    await t.settled();
    assert.equal((await t.state()).hosts.length, 1);
    assert.match(await t.text(await t.row(t.world.local)), /local-tree/);
    assert.equal(saved(t).hosts.length, 0);
  }],
});
