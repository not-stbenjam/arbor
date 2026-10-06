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
    const r = f.cli(...args); assert.equal(r.status, 2, args.join(" ")); assert.ok(r.stderr);
  }
  assert.equal(f.cli("remove", b.path, "--yes").status, 1, "refused removal is an operational failure");
  assert.equal(f.cli("remove", a.path, "--head=").status, 2);
  assert.equal(f.cli("list", "--sort=invalid").status, 2);
  assert.equal(f.cli("list", "--older-than=invalid").status, 2);
  for (const flags of [[], ["--all"], ["--all", "--force"], ["--yes=false"], ["--yes", "--yes=false"]]) {
    assert.equal(json(f.cli("clean", "-p", f.root, "--json", ...flags)).dryRun, true);
    assert.ok(f.exists(a.path)); assert.ok(f.exists(b.path));
  }
  json(f.cli("remove", a.path, "--head", repo.head(), "--repo", repo.path, "--recommended-only", "--json"));
  const snapshot = list(f).worktrees.find((w) => w.path === a.path);
  json(f.cli("remove", a.path, "--json", "--id", snapshot.id, "--branch", snapshot.branch, "--stats-session=valid_session", "--keep-local"));
  json(f.cli("remove", b.path, "--json", "--discard-local", "--acknowledge=operation", "--acknowledge=nested", "--acknowledge=submodules"));
  assert.equal(json(f.cli("list", "--path", a.path, "--target-only", "--repo", repo.path, "--json")).worktrees.length, 1);
  for (const extra of [["--head=wrong"], ["--id=wrong"], ["--branch="], ["--stats-session=bad space"], ["--expect-missing"], ["--expect-empty"], ["--repo=-missing"]]) assert.notEqual(f.cli("remove", a.path, "--yes", ...extra).status, 0);
  for (const exclude of ["", ".", "..", "["]) assert.equal(f.cli("list", "--path", f.root, "--exclude", exclude).status, 2);
  const dashRepo = f.repository("-scan", { remote: false });
  dashRepo.worktree("dash-inside", { at: "-scan/linked" });
  assert.equal(json(f.cli("list", "--path=-scan", "--json")).worktrees.length, 1);
  const watched = f.run(f.env.ARBOR_CLI_PATH, ["list", "--path", f.root, "--watch-stdin", "--json"], { input: "" });
  assert.equal(watched.status, 130); assert.match(watched.stderr, /interrupted/);
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
