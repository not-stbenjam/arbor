"use strict";
const { main, scenario, assert, fs, path, quote, ok } = require("./helpers.cjs");
main(() => scenario("readonly", async (f) => {
  const repo = f.repository("projects/repo", { files: { ".gitattributes": "README.md diff=probe filter=probe\n" } });
  const w = repo.worktree("target", { commits: 1 });
  const log = f.path("helpers.log");
  const helper = (name, tail = ":") => f.tool(`probe-${name}`, `printf '%s\\n' ${quote(name)} >> ${quote(log)}\n${tail}`);
  repo.git("config", "core.fsmonitor", helper("fsmonitor"));
  const hooks = f.path("hooks"); fs.mkdirSync(hooks);
  for (const name of ["post-index-change", "post-checkout", "pre-commit", "reference-transaction"]) {
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\nprintf '%s\\n' ${quote(name)} >> ${quote(log)}\n`, { mode: 0o755 });
  }
  repo.git("config", "core.hooksPath", hooks);
  for (const [key, name] of [["diff.probe.command", "diff"], ["diff.probe.textconv", "textconv"], ["core.pager", "pager"], ["core.editor", "editor"], ["alias.status", "alias"]]) repo.git("config", key, helper(name));
  // An unchanged index need not run a clean filter; its changed-file case lives
  // in bugs/read-only-filter.cjs with the full read-only assertion.
  repo.git("config", "filter.probe.clean", helper("filter", "cat"));
  repo.git("config", "filter.probe.smudge", helper("smudge", "cat"));
  // Refresh index timestamps before taking the snapshot, with helpers disabled.

  f.git(w.path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "filter.probe.clean=cat", "update-index", "--refresh");
  fs.rmSync(log, { force: true });
  for (const args of [["list", "--path", f.root, "--json"], ["clean", "--path", f.root, "--json"], ["stats", "--json"]]) {
    ok(f.cli(...args));
    const ran = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    console.log(`${args[0]} helpers: ${JSON.stringify(ran)}`); assert.deepEqual(ran, []);
  }
  assert.equal(f.statistics(), null);
}));
