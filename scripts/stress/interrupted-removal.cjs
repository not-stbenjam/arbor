"use strict";
const { main, scenario, assert, fs, ok, json, random, start, integrity } = require("./helpers.cjs");
main(async () => {
  const rand = random();
  const rounds = Number(process.env.STRESS_INTERRUPTS || 240);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"];
  for (let i = 0; i < rounds; i++) await scenario(`interrupt-${i}`, async (f) => {
    const repo = f.repository("projects/repo", { remote: false });
    for (let n = 0; n < 3; n++) repo.worktree(`w-${n}`);
    const cleaning = i % 2 === 1, signal = signals[Math.floor(i / 2) % signals.length];
    const delay = Math.floor(rand() * 60);
    console.log(`trial=${i} signal=${signal} delay=${delay}ms phase=${cleaning ? "remove" : "scan"}`);
    let timer, triggered = false;
    const proc = start(f, [cleaning ? "clean" : "list", "--path", f.root, "--json", "--progress", ...(cleaning ? ["--yes"] : [])], {
      output(chunk, stderr, child) {
        if (cleaning && stderr && !triggered && chunk.includes('"stage":"remove"')) {
          triggered = true; timer = setTimeout(() => child.kill(signal), delay);
        }
      },
    });
    if (!cleaning) timer = setTimeout(() => proc.child.kill(signal), delay);
    let result;
    try { result = await proc.done; } finally { clearTimeout(timer); }
    assert.ok([0, 1, 130, null].includes(result.status));
    if (cleaning) assert.ok(triggered, "never reached removal phase");
    integrity(f, repo);
    const finish = json(f.cli("clean", "--path", f.root, "--yes", "--json"));
    assert.ok(finish.every((r) => r.removed));
    integrity(f, repo); assert.equal(repo.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
    if ((i + 1) % 20 === 0) console.log(`interruptions=${i + 1}/${rounds} last=${signal} delay=${delay}ms phase=${cleaning ? "remove" : "scan"}`);
  });
});
