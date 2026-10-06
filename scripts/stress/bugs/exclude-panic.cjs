"use strict";
const { main, scenario, assert } = require("../helpers.cjs");
main(() => scenario("bug-exclude", async (f) => {
  const r = f.cli("list", "--path", f.root, "--exclude", "0*\\", "--json");
  console.log(r); assert.ok(!r.stderr.includes("panic:"), "malformed exclusions must return a usage error, never panic");
}));
