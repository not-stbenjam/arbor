"use strict";
const { scenario, assert } = require("./harness.cjs");
const { saved, open, closed, select, machine, cached } = require("./setup-helpers.cjs");
scenario({ name: "host settings retain separate drafts", timeout: 25,
  setup(f) {
    const h = f.host("optionsbox");
    const local = f.repository("other/repo").worktree("local-other").path;
    const remote = f.repository(h.relative("other/repo")).worktree("remote-other").path;
    f.preferences({ hosts: [{ host: h.name, name: h.name, root: "~/projects" }] });
    return { local, remote, root: f.path("other") };
  }, launches: [async (t) => {
    await t.settled();
    await t.click("#settings-button");
    await open(t, "settings-dialog");
    await t.fill("#scan-root", t.world.root);
    await t.click("#scan-fetch");
    await select(t, "#settings-host", 1);
    assert.equal(await t.visible("#choose-folder"), false);
    await t.fill("#scan-root", "~/other");
    await t.click("#settings-dialog summary");
    await t.fill("#scan-excludes", "remote-skip");
    await select(t, "#settings-host", 0);
    assert.equal(await t.value("#scan-root"), t.world.root);
    assert.equal(await t.checked("#scan-fetch"), true);
    await t.click("#settings-save");
    await t.until(async () => (await t.value("#settings-host")) === "optionsbox", "remaining remote draft shown");
    assert.match(await t.text("#settings-note"), /still has unsaved changes/);
    assert.equal(await t.value("#scan-root"), "~/other");
    assert.equal(await t.checked("#scan-fetch"), false);
    await t.click("#settings-save");
    await closed(t, "settings-dialog");
    await t.settled();
    const p = saved(t);
    const local = p.scans.find((x) => x.host === ""), remote = p.scans.find((x) => x.host === "optionsbox");
    assert.equal(local.root, t.world.root); assert.equal(local.fetch, true);
    assert.equal(remote.root, "~/other"); assert.equal(remote.fetch, false);
    assert.deepEqual(remote.excludes, ["remote-skip"]);
    await cached(t, t.world.local); await cached(t, t.world.remote);
    await machine(t, null);
    assert.equal((await t.rows()).filter((r) => !r.folder).length, 2);
  }],
});
