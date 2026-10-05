"use strict";
const { scenario } = require("./harness.cjs");
const { scaleFixture, scaleRun } = require("./stress-helpers.cjs");
scenario({
  name: "scale 3000 real worktrees", timeout: 600,
  setup: f => scaleFixture(f, 3000),
  launches: [t => scaleRun(t, { deletion: false })],
});
