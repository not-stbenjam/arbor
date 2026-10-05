"use strict";
const { main, scenario, assert, fs, path, realCLI, ok, json, list } = require("./helpers.cjs");
main(() => scenario("commands", async (f) => {
  const repo = f.repository("projects/repo");
  const a = repo.worktree("a"), b = repo.worktree("b", { modified: true });
  for (const command of [[], ["--help"], ...["list", "clean", "remove", "stats", "version", "completion", "gui", "help"].map((x) => [x, "--help"])]) {
    assert.match(ok(f.cli(...command)).stdout, /Usage:/);
  }
  assert.equal(ok(f.cli("version")).stdout, ok(f.cli("--version")).stdout);
  for (const shell of ["bash", "zsh", "fish", "powershell"]) {
    ok(f.cli("completion", shell, "--help"));
    for (const flags of [[], ["--no-descriptions"]]) assert.ok(ok(f.cli("completion", shell, ...flags)).stdout.length > 100);
  }
  for (const args of [["--recommended"], ["-q"], ["--progress"], ["--fetch", "--github"], ["--linked-only=false"], ["--host="], ["--json", "--json"], ["--path", f.root, "--path", f.root]]) list(f, ...args);
  assert.equal(list(f, "--exclude", "a", "--exclude", "b").worktrees.length, 0);
  assert.equal(list(f, "--no-default-excludes", "--exclude", "a,b").worktrees.length, 2);
  assert.equal(json(f.cli("list", "--path=", "--json")).root, f.home);
  for (const args of [["nonsense"], ["list", "--unknown"], ["clean", "--force"], ["remove"], ["remove", a.path, b.path], ["list", "--path"], ["list", "--json=bad"], ["list", "--", "--json"], ["remove", a.path, "--force", "--recommended-only"], ["remove", a.path, "--force", "--keep-local"], ["remove", a.path, "--acknowledge=unknown"], ["remove", a.path, "--expect-empty", "--expect-missing"]]) {
    const r = f.cli(...args); assert.notEqual(r.status, 0, args.join(" ")); assert.ok(r.stderr);
  }
  for (const flags of [[], ["--all"], ["--all", "--force"], ["--yes=false"], ["--yes", "--yes=false"]]) {
    assert.equal(json(f.cli("clean", "-p", f.root, "--json", ...flags)).dryRun, true);
    assert.ok(f.exists(a.path)); assert.ok(f.exists(b.path));
  }
  json(f.cli("remove", a.path, "--head", repo.head(), "--repo", repo.path, "--recommended-only", "--json"));
  const dash = repo.worktree("-dash", { at: "-dash", branch: "dash" });
  json(f.cli("remove", "--json", "--", "-dash")); assert.ok(f.exists(dash.path));
  // Linux lookup is executable-relative and PATH-based. Both are fixture-only.
  if (process.platform === "linux") {
    const binary = f.path("isolated", "deep", "bin", "arbor");
    fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.copyFileSync(realCLI(), binary); fs.chmodSync(binary, 0o700);
    const r = f.run(binary, ["gui", "--path", f.root], { env: { PATH: f.path("empty-path") } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /native Arbor app not found/);
  } else console.log("SKIP gui launch: macOS has a fixed /Applications lookup");
  assert.equal(json(f.cli("stats", "--json")).removedWorktrees, 0);
}));
