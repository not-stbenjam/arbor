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
  const disconnect = f.write("disconnect.py", `import os,signal,subprocess,sys
p=subprocess.Popen(sys.argv[1:],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
try:
 for line in p.stderr:
  sys.stderr.buffer.write(line); sys.stderr.buffer.flush()
  if line.startswith(b'@arbor-progress '):
   os.killpg(p.pid,signal.SIGTERM)
   p.communicate(timeout=10)
   sys.stdout.write('{"root":')
   sys.stderr.write('connection ended\\n')
   sys.exit(255)
 raise RuntimeError('remote emitted no scan progress')
finally:
 try: os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError: pass
 p.wait()
`);
  f.tool("ssh", `case "$*" in *--watch-stdin*) exec python3 ${quote(disconnect)} ${quote(original)} "$@";; esac\nexec ${quote(original)} "$@"`);
  const cut = f.cli("list", "--host", host.name, "--path", host.root, "--json", "--progress"); assert.notEqual(cut.status, 0); assert.match(cut.stderr, /connection ended/);
  console.log("SKIP unseeded release download: production URL has no CLI override; tested separately with an injected Go HTTP transport");
}));
