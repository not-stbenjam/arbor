"use strict";
const { main, scenario, assert, fs, path, json, ok, quote } = require("./helpers.cjs");
main(() => scenario("ssh", async (f) => {
  const host = f.host("test-host");
  const repo = f.repository(host.relative("projects", "repo ' quoted"));
  const w = repo.worktree("tree ' $() ;", { branch: "topic", at: host.relative("projects", "tree ' $() ;") });
  for (const root of [host.root, "~/projects", "~", ""]) {
    const r = json(f.cli("list", "--host", host.name, "--path", root, "--json", "--progress"));
    assert.equal(r.worktrees.length, 1); assert.equal(r.worktrees[0].path, w.path);
  }
  host.delay(0.05); json(f.cli("list", "--host", host.name, "--path", host.root, "--json")); host.delay(0);
  host.refuse(); const bad = f.cli("list", "--host", host.name, "--path", host.root, "--json");
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /online and reachable/); host.accept();
  const connections = f.connections().length;
  for (const name of ["-bad", "bad host", "bad;host", "bad$(host)", "bad'host", "bad\nhost", "a".repeat(256)]) assert.notEqual(f.cli("stats", "--host", name).status, 0);
  assert.equal(f.connections().length, connections);
  json(f.cli("remove", "--host", host.name, w.path, "--yes", "--json"));
  assert.equal(json(f.cli("stats", "--host", host.name, "--json")).removedWorktrees, 1); assert.equal(f.statistics(), null);
  // Keep the fixture's local SSH implementation for probes, but terminate the
  // simulated channel after a truncated scan reply. No real ssh is reachable.
  const original = f.path("bin", "ssh-original"); fs.renameSync(f.path("bin", "ssh"), original);
  f.tool("ssh", `case "$*" in *--watch-stdin*) printf '{"root":'; printf 'connection ended\\n' >&2; exit 255;; esac\nexec ${quote(original)} "$@"`);
  const cut = f.cli("list", "--host", host.name, "--path", host.root, "--json"); assert.notEqual(cut.status, 0); assert.match(cut.stderr, /connection ended/);
  console.log("SKIP unseeded release download: production URL has no CLI override; tested separately with an injected Go HTTP transport");
}));
