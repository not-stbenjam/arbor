"use strict";
const { scenario } = require("./harness.cjs");
const { scaleFixture, scaleRun } = require("./stress-helpers.cjs");
scenario({
  name: "scale 1000 real worktrees", timeout: 600,
  setup: f => scaleFixture(f, 1000),
  launches: [t => scaleRun(t, { deletion: true })],
});
