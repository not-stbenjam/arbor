"use strict";
const { scenario, assert } = require("./harness.cjs");
const { machine, saved, open, scans } = require("./setup-helpers.cjs");
scenario({ name: "host errors stop and independent local scan", timeout: 28,
  setup(f) {
    f.host("offline").refuse();
    f.host("slow").delay(3);
    const local = f.repository("projects/repo").worktree("local").path;
    f.preferences({ hosts: [{ host: "offline", name: "offline", root: "~/projects" }, { host: "slow", name: "slow", root: "~/projects" }] });
    return { local };
  }, launches: [async (t) => {
    await t.until(() => t.visible('[data-stop-host="slow"]'), "slow host has Stop");
    await t.step("Settings explains why a running host cannot save", async () => {
      await machine(t, "slow");
      await t.click("#settings-button");
      await open(t, "settings-dialog");
      await t.fill("#scan-root", "~/other");
      assert.equal(await t.enabled("#settings-save"), false);
      // The window's own Stop is behind Settings, so Settings has one, and
      // what was typed is still there once the scan has stopped.
      assert.match(await t.text("#settings-progress"), /slow is still scanning\. What you change here is kept/);
      await t.click("#settings-stop");
      await t.until(() => t.enabled("#settings-save"), "Save & scan once the scan has stopped");
      assert.equal(await t.visible("#settings-progress"), false);
      assert.equal(await t.value("#scan-root"), "~/other");
      await t.press("Escape");
      assert.equal(saved(t).hosts.find((h) => h.host === "slow").root, "~/projects");
      // settled() cannot represent a stopped scan: its persistent progress row is intentional.
      await t.until(async () => !(await t.state()).hosts.some((h) => h.busy), "all host operations settle");
      await t.until(async () => /Scan stopped/.test(await t.text('[data-progress-host="slow"]')), "stopped explanation");
      assert.match(await t.text('[data-progress-host="slow"]'), /Refresh to scan again/);
    });
    await t.step("failure gives recovery advice while local work remains available", async () => {
      await machine(t, null);
      await t.until(() => t.visible("#error-banner"), "SSH error banner");
      assert.match(await t.text("#error-message"), /offline.*SSH.*online and reachable/s);
      assert.match(await t.text("#status-message"), /1 host unavailable/);
      assert.match(await t.text(await t.row(t.world.local)), /local/);
      await t.click("#dismiss-error");
      assert.equal(await t.visible("#error-banner"), false);
      t.fixture.host("slow").delay(0);
      await t.click("#statistics-button");
      await t.until(() => t.text(".statistics-warning"), "partial statistics warning");
      assert.match(await t.text(".statistics-warning"), /offline/);
      assert.match(await t.text("#statistics-content"), /hosts that answered/);
      await t.press("Escape");
      await machine(t, "");
      const before = scans(t).length;
      await t.click("#refresh-button");
      await t.until(() => scans(t).length > before, "local refresh starts despite failed host");
      await t.until(async () => !(await t.state()).hosts.find((h) => h.host === "").busy, "local refresh finishes");
      assert.ok(t.fixture.exists(t.world.local));
    });
  }],
});
