#!/usr/bin/env node
"use strict";

// Runs the end-to-end scenarios beside this file, each in its own run of the
// application and its own throwaway folder.
//
//   node scripts/e2e/run.cjs              every *.e2e.cjs here
//   node scripts/e2e/run.cjs review keys  only those whose file name has a word
//   node scripts/e2e/run.cjs path/to.cjs  that file, wherever it is
//
// --jobs N runs that many at once (2). --keep leaves every folder behind;
// a failed scenario's folder is always left, with a picture of the window.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args.splice(at, 2)[1];
};
const jobs = Math.max(1, Number(option("--jobs", 2)));
const keep = args.includes("--keep") && args.splice(args.indexOf("--keep"), 1);
// A scenario named by its path is run as given; anything else is a word to
// find among the scenarios beside this file.
const named = args.filter((value) => value.endsWith(".cjs") && fs.existsSync(value));
const words = args.filter((value) => !named.includes(value));
const scenarios = [
  ...named.map((value) => path.resolve(value)),
  ...fs
    .readdirSync(__dirname)
    .filter((name) => name.endsWith(".e2e.cjs"))
    .filter((name) => (words.length ? words.some((word) => name.includes(word)) : !named.length))
    .sort()
    .map((name) => path.join(__dirname, name)),
];
if (!scenarios.length) {
  console.error("No scenario matches.");
  process.exit(1);
}

const electron = path.join(root, "node_modules", ".bin", "electron");
// Linux needs a display; without one, each run gets a virtual one.
const headless =
  process.platform === "linux" &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY;
if (headless && spawnSync("xvfb-run", ["--help"]).error) {
  console.error("No display: install xvfb, or run inside a desktop session.");
  process.exit(1);
}

function run(file) {
  const name = path.relative(__dirname, file);
  const command = headless ? "xvfb-run" : electron;
  const prefix = headless ? ["-a", electron] : [];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, [...prefix, file, "--no-sandbox"], {
      cwd: root,
      env: { ...process.env, ...(keep ? { ARBOR_E2E_KEEP: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("close", (code) =>
      resolve({ name, code, output, seconds: (Date.now() - started) / 1000 }),
    );
  });
}

(async () => {
  const queue = [...scenarios], results = [];
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let name; (name = queue.shift()); ) {
        const result = await run(name);
        results.push(result);
        // Chromium's own chatter under a virtual display is not ours to read.
        const lines = result.output
          .split("\n")
          .filter((line) => line.trim() && !/^\[\d+:\d+\/|dbus|GLib|Gtk-|libEGL|MESA|vaInitialize/.test(line));
        console.log(
          `${result.code === 0 ? "PASS" : "FAIL"}  ${name}  ${result.seconds.toFixed(1)}s`,
        );
        if (result.code !== 0 || process.env.ARBOR_E2E_VERBOSE)
          console.log(lines.map((line) => `      ${line}`).join("\n"));
      }
    }),
  );
  const failed = results.filter((result) => result.code !== 0);
  console.log(
    `\n${results.length - failed.length} of ${results.length} scenarios passed` +
      (failed.length ? `; failed: ${failed.map((result) => result.name).join(", ")}` : ""),
  );
  process.exit(failed.length ? 1 : 0);
})();
