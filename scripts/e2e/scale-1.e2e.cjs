"use strict";
const { scenario } = require("./harness.cjs");
const { scaleFixture, scaleRun } = require("./stress-helpers.cjs");
scenario({
  name: "scale 1 real worktrees", timeout: 600,
  setup: f => scaleFixture(f, 1),
  launches: [t => scaleRun(t, { deletion: false })],
});
