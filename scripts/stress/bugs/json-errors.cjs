"use strict";
const { main, scenario, assert } = require("../helpers.cjs");
main(() => scenario("bug-json", async (f) => {
  for (const args of [["list", "--path", f.path("missing"), "--json"], ["remove", "--json"], ["clean", "--json", "--force"], ["stats", "--json", "--host=-bad"]]) {
    const r = f.cli(...args); console.log({ args, ...r });
    assert.notEqual(r.status, 0); assert.doesNotThrow(() => JSON.parse(r.stdout), "JSON errors need a structured stdout result");
  }
}));
