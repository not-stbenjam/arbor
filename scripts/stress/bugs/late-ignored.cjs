"use strict";
const { main, scenario, assert, fs, quote, entry } = require("../helpers.cjs");
main(() => scenario("bug-late-ignored", async (f) => {
  const repo = f.repository("projects/repo"), w = repo.worktree("target");
  const shown = entry(f, w); assert.ok(shown.recommended);
  const git = f.run("sh", ["-c", "command -v git"]).stdout.trim();
  const marker = f.path("late-file-created");
  // Inject work after the final identity query has read HEAD, immediately
  // before Git removes the tree. Git's own removal check ignores ignored files.
  f.tool("git", `case "$*" in *'symbolic-ref --quiet HEAD'*)
${quote(git)} "$@"
status=$?
printf 'local work' > ${quote(w.path + "/important.log")}
touch ${quote(marker)}
exit "$status";;
esac
exec ${quote(git)} "$@"`);
  const r = f.cli("remove", w.path, "--head", shown.head, "--recommended-only", "--yes", "--json"); console.log(r);
  assert.ok(fs.existsSync(marker), "did not reach the final identity check");
  assert.ok(f.exists(w.path + "/important.log"), "new ignored work was deleted without --force");
}));
