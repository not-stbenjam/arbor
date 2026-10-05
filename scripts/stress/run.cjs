#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const topics = ["commands", "output", "confirmation", "consistency", "interruption", "concurrency", "layouts", "readonly", "scale", "ssh"];
const names = process.argv.slice(2);
let failed = false;
for (const name of names.length ? names : topics) {
  const relative = name.replace(/^scripts\/stress\//, "").replace(/\.cjs$/, "");
  if (!topics.includes(relative) && !/^bugs\/[a-z0-9-]+$/.test(relative)) throw new Error(`Unknown topic: ${name}`);
  const file = path.join(__dirname, `${relative}.cjs`);
  if (!fs.existsSync(file)) throw new Error(`Missing topic: ${relative}`);
  const began = performance.now();
  const result = spawnSync(process.execPath, [file], { stdio: "inherit", env: process.env });
  const pass = result.status === 0;
  console.log(`${pass ? "PASS" : "FAIL"} ${relative} ${((performance.now() - began) / 1000).toFixed(2)}s`);
  failed ||= !pass;
}
process.exitCode = failed ? 1 : 0;
