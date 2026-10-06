"use strict";
const { main, scenario, assert, fs, quote, json } = require("../helpers.cjs");
main(async () => {
  const samples = [];
  for (const count of [20, 40]) await scenario(`bug-quadratic-${count}`, async (f) => {
    const repo = f.repository("projects/repo", { remote: false });
    for (let i = 0; i < count; i++) repo.worktree(`w-${String(i).padStart(3, "0")}`);
    const git = f.run("sh", ["-c", "command -v git"]).stdout.trim();
    const log = f.path("registration-bytes");
    f.tool("git", `case "$*" in *'worktree list --porcelain'*)
out=$(mktemp ${quote(f.path("tmp", "listed.XXXXXX"))})
${quote(git)} "$@" > "$out"
status=$?
wc -c < "$out" >> ${quote(log)}
cat "$out"
rm "$out"
exit "$status";;
esac
exec ${quote(git)} "$@"`);
    const began = performance.now();
    const results = json(f.cli("clean", "--path", f.root, "--yes", "--json"));
    assert.equal(results.filter((r) => r.removed).length, count);
    const bytes = fs.readFileSync(log, "utf8").trim().split("\n").map(Number);
    samples.push({ worktrees: count, enumerations: bytes.length, bytes: bytes.reduce((a, b) => a + b, 0), seconds: (performance.now() - began) / 1000 });
  });
  console.log(samples);
  assert.ok(samples[1].bytes / samples[0].bytes < 2.6, "doubling worktrees nearly quadrupled registration data parsed during cleanup");
});
