"use strict";
const { main, scenario, assert, fs, path, quote, ok } = require("./helpers.cjs");
main(() => scenario("readonly-filter", async (f) => {
  const repo = f.repository("projects/repo", { files: { ".gitattributes": "README.md filter=probe\n" } });
  const w = repo.worktree("target");
  fs.writeFileSync(path.join(w.path, "README.md"), "x".repeat(fs.statSync(path.join(w.path, "README.md")).size));
  const marker = f.path("filter-ran");
  const helper = f.tool("filter-probe", `printf 'filter\\n' >> ${quote(marker)}\ncat`);
  repo.git("config", "filter.probe.clean", helper);
  const ran = {};
  for (const args of [["list", "--path", f.root, "--json"], ["clean", "--path", f.root, "--json"], ["stats", "--json"]]) {
    fs.rmSync(marker, { force: true }); ok(f.cli(...args));
    ran[args[0]] = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
  }
  console.log(ran); assert.deepEqual(ran, { list: [], clean: [], stats: [] }, "read-only commands must not run configured helpers");
}));
