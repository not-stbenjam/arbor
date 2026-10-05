"use strict";
const fs = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
const { workspace } = require("./workspace.cjs");
const { f, repos, trees, host } = workspace();
const records = [];
function run(label, args, options) {
  const result = options ? f.run(f.path("bin/arbor-cli"), args, options) : f.cli(...args);
  records.push({ label, args, ...result });
  return result;
}
run("bare", []); run("root-help", ["--help"]);
for (const command of ["list", "clean", "remove", "stats", "gui", "version", "completion"]) {
  run(`help-${command}`, ["help", command]); run(`flag-help-${command}`, [command, "--help"]);
}
for (const shell of ["bash", "zsh", "fish", "powershell"]) {
  run(`completion-help-${shell}`, ["completion", shell, "--help"]);
  f.write(`completion.${shell}`, run(`completion-${shell}`, ["completion", shell]).stdout);
}
for (const args of [["version"], ["--version"], ["stats"], ["stats", "--json"],
 ["__complete", "list", "--host", ""], ["__complete", "list", "--path", ""],
 ["__complete", "remove", ""], ["__complete", "", ""],
 ["list", "--path", f.root, "--json"], ["list", "--path", f.root, "--recommended"],
 ["list", "--path", f.root, "--linked-only=false", "--json"],
 ["list", "--path", f.root, "--json", "--progress"],
 ["list", "--path", f.root, "--fetch", "--github"],
 ["list", "--path", f.root, "--exclude", "team-1", "--no-default-excludes"],
 ["clean", "--path", f.root, "--json"], ["clean", "--path", f.root, "--all"],
 ["clean", "--path", f.root, "--all", "--force", "--json"],
 ["list", "--host", host.name, "--path", "~/projects", "--json"],
 ["clean", "--host", host.name, "--path", "~/projects"], ["stats", "--host", host.name]]) run(args.join(" "), args);
for (const width of [40, 80, 100, 200]) {
  for (const args of [["list", "-p", f.root], ["clean", "-p", f.root], ["clean", "-p", f.root, "--all", "--force"],
    ["remove", trees[4].path], ["stats"], ["--help"]]) {
    records.push({label:`pty-${width}`, args, ...f.run("python3", [path.join(__dirname, "terminal.py"), String(width), f.path("bin/arbor-cli"), ...args])});
  }
}
if (records.filter(r => r.label.startsWith("pty-")).some(r => r.status !== 0)) throw new Error("Terminal matrix failed");
run("no-color", ["list", "-p", f.root, "-q"], {env:{NO_COLOR:"1"}});
for (const args of [["lsit"], ["list", "--wat"], ["list", "--json=maybe"], ["clean", "--force"],
 ["list", "-p", f.path("no-such-folder")], ["list", "-p", f.path("gitconfig")],
 ["remove", f.path("home")], ["remove", repos[0].path, "--yes"],
 ["remove", trees[0].path, "--head", "0000", "--yes"],
 ["remove", trees[4].path, "--yes"], ["remove", trees[7].path, "--yes"],
 ["list", "--host", "unknown"], ["list", "--host", "-bad"],
 ["list", "-p", f.home], ["clean", "-p", f.home, "--yes"],
 ["list", "-p", f.root, "--exclude", "[bad"]]) run("error-or-empty", args);
host.refuse(); run("unreachable", ["list", "--host", host.name]); host.accept();
const denied = f.path("projects/denied"); fs.mkdirSync(denied); fs.chmodSync(denied, 0);
run("permission", ["list", "-p", denied]); fs.chmodSync(denied, 0o700);
run("git-missing", ["list", "-p", f.root], {env:{PATH:f.path("empty-path")}});
run("enter-preview", ["clean", "-p", f.root], {input:"\n"});
// Real deletion, including partial failure. Git's stand-in delegates every other call.
const gitPath = f.run("sh", ["-c", "command -v git"]).stdout.trim();
f.tool("git", `case "$*" in *"worktree remove"*"task-01"*) echo 'simulated device failure' >&2; exit 1;; esac\nexec '${gitPath}' "$@"`);
const partial = run("partial-batch", ["clean", "-p", f.root, "--yes", "--json"]);
assert.equal(partial.status, 1);
assert(JSON.parse(partial.stdout).some(r => !r.removed));
assert(JSON.parse(partial.stdout).some(r => r.removed));
fs.unlinkSync(f.path("bin/git"));
run("remote-delete", ["clean", "--host", host.name, "--path", "~/projects", "--yes"]);
run("force-delete", ["remove", trees[4].path, "--force", "--yes"]);
run("stats-after", ["stats", "--json"]);
f.write("review.json", JSON.stringify(records, null, 2));
console.log(JSON.stringify({ directory:f.directory, commands:records.length, trees:trees.length }));
