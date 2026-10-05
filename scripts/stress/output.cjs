"use strict";
const { main, scenario, assert, fs, path, json, ok, start } = require("./helpers.cjs");
main(() => scenario("output", async (f) => {
  const repo = f.repository("projects/repo");
  const w = repo.worktree("target");
  const report = json(f.cli("list", "--path", f.root, "--json", "--progress"));
  assert.deepEqual(Object.keys(report).sort(), ["durationMs", "fetched", "github", "root", "scannedAt", "warnings", "worktrees"]);
  assert.equal(report.worktrees.length, 1);
  for (const field of ["path", "id", "head", "branch", "commonDir"]) assert.equal(typeof report.worktrees[0][field], "string");
  for (const command of ["list", "clean"]) {
    const r = f.cli(command, "--path", f.root, "--json", "--progress"); json(r);
    const events = r.stderr.trim().split("\n").filter(Boolean).map((line) => { assert.ok(line.startsWith("@arbor-progress ")); return JSON.parse(line.slice(16)); });
    assert.ok(events.some((e) => e.stage === "inspect" && e.completed === 1));
    assert.equal(f.cli(command, "--path", f.root, "--json").stderr, "");
  }
  for (const env of [{ NO_COLOR: "1" }, { TERM: "dumb" }, { LC_ALL: "C", LANG: "C" }]) {
    const r = ok(f.run(f.env.ARBOR_CLI_PATH, ["list", "-p", f.root], { env }));
    assert.ok(!r.stdout.includes("\x1b")); assert.match(r.stderr, /Scanning/);
  }
  for (const width of [12, 400]) {
    const python = `import os,pty,fcntl,termios,struct,subprocess,sys\nm,s=pty.openpty()\nfcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',24,${width},0,0))\np=subprocess.Popen(sys.argv[1:],stdout=s,stderr=subprocess.PIPE)\nos.close(s)\nout=b''\nwhile True:\n try: chunk=os.read(m,65536)\n except OSError: break\n if not chunk: break\n out+=chunk\nos.close(m)\nerr=p.communicate(timeout=30)[1]\nsys.stdout.buffer.write(out)\nsys.stderr.buffer.write(err)\nsys.exit(p.returncode)\n`;
    const r = ok(f.run("python3", ["-c", python, f.env.ARBOR_CLI_PATH, "list", "-p", f.root]));
    assert.match(r.stdout, /target/); assert.ok(!r.stdout.includes("\x1b"));
    console.log(`terminal width=${width} max-line=${Math.max(...r.stdout.split("\n").map((s) => s.length))}`);
  }
  // A Python parent closes descriptors before exec; no shell pipeline can hide
  // the producer's exit status behind head's successful exit.
  for (const closed of [1, 2]) {
    const py = `import os,subprocess,sys\ndef close(): os.close(${closed})\np=subprocess.run(sys.argv[1:],stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=close,timeout=30)\nprint(p.returncode)\n`;
    const r = ok(f.run("python3", ["-c", py, f.env.ARBOR_CLI_PATH, "list", "-p", f.root]));
    console.log(`closed fd ${closed}: exit ${r.stdout.trim()}`);
    assert.ok(Number.isInteger(Number(r.stdout.trim())));
  }
  const pipe = start(f, ["completion", "bash"]);
  pipe.child.stdout.destroy();
  const closed = await pipe.done; assert.ok(closed.status !== null || closed.signal === "SIGPIPE");
  const preview = json(f.cli("remove", w.path, "--json")); assert.equal(preview.dryRun, true);
  assert.deepEqual(Object.keys(preview).sort(), ["dryRun", "requiresForce", "warnings", "worktrees"]);
  const removed = json(f.cli("remove", w.path, "--yes", "--json")); assert.deepEqual(removed, { path: w.path, removed: true });
  assert.deepEqual(json(f.cli("clean", "-p", f.root, "--yes", "--json")), []);
  assert.equal(json(f.cli("stats", "--json")).removedWorktrees, 1);
}));
