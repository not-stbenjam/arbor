#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const targets = [
  ["./internal/worktree", "FuzzPorcelain"], ["./internal/worktree", "FuzzExclusionComponent"],
  ["./internal/engine", "FuzzProgress"], ["./internal/engine", "FuzzHostVersion"],
  ["./internal/stats", "FuzzStatistics"], ["./internal/config", "FuzzConfiguration"],
  ["./cmd/arbor", "FuzzRequest"],
];
const selected = process.argv.slice(2);
for (const [pkg, target] of targets) {
  if (selected.length && !selected.includes(target)) continue;
  const r = spawnSync("go", ["test", "-p", "2", pkg, "-run=^$", `-fuzz=^${target}$`, "-fuzztime=120s", "-parallel=1"], { stdio: "inherit", env: { ...process.env, GOMAXPROCS: "2" } });
  if (r.status !== 0) { process.exitCode = 1; break; }
}
