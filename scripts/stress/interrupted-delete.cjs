"use strict";
const { main, scenario, assert, fs, start, ok } = require("./helpers.cjs");
main(() => scenario("bug-interrupted-delete", async (f) => {
  const repo = f.repository("projects/repo", { remote: false }), w = repo.worktree("target");
  const barrier = f.path("directory-removed"), library = f.path("pause.so");
  // Pause Git immediately after its successful rmdir, before it removes the
  // registration. This makes the randomized failure reproducible. The shim
  // calls the real rmdir; Arbor still delegates the deletion to actual Git.
  const source = f.write("pause.c", `#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
int rmdir(const char *name) {
 int (*original)(const char *) = dlsym(RTLD_NEXT, "rmdir");
 int result = original(name);
 const char *target = getenv("ARBOR_STRESS_TARGET");
 if (result == 0 && target && strcmp(name, target) == 0) {
  int fd = open(getenv("ARBOR_STRESS_BARRIER"), O_CREAT|O_WRONLY, 0600);
  if (fd >= 0) close(fd);
  sleep(20);
 }
 return result;
}
`);
  ok(f.run("cc", ["-shared", "-fPIC", "-o", library, source, "-ldl"], { env: { CCACHE_DIR: f.path("ccache") } }));
  const proc = start(f, ["clean", "--path", f.root, "--yes", "--json"], { env: {
    LD_PRELOAD: library, ARBOR_STRESS_TARGET: w.path, ARBOR_STRESS_BARRIER: barrier,
  } });
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(barrier) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fs.existsSync(barrier), "Git rmdir pause was not reached");
    proc.child.kill("SIGTERM"); const result = await proc.done;
    const retry = f.cli("clean", "--path", f.root, "--yes", "--json");
    const registrations = repo.git("worktree", "list", "--porcelain");
    console.log({ result, retry, registrations });
    assert.equal(retry.status, 0);
    assert.ok(!registrations.includes(w.path), "retry left the interrupted deletion's stale registration");
  } finally { proc.kill(); await proc.done; }
}));
