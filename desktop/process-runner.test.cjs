"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execute, CommandError } = require("./process-runner.cjs");

test("nonzero child diagnostics stay within 4 KiB while structured stdout remains exact", async () => {
  const stdout = JSON.stringify({
    path: "/work/topic",
    removed: false,
    error: "Check the lock owner before removing the stale lock.",
  });
  await assert.rejects(
    execute(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write('Actionable prefix: ' + '🌳'.repeat(100000));process.exitCode=2;`,
    ]),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.code, 2);
      assert.equal(error.stdout, stdout);
      assert.ok(Buffer.byteLength(error.message) <= 4096);
      assert.match(error.message, /^Actionable prefix: /);
      assert.match(error.message, /\[diagnostic truncated\]$/);
      assert.doesNotMatch(error.message, /\uFFFD/);
      return true;
    },
  );
});

test("normal nonzero diagnostics retain their complete message", async () => {
  const message = "Could not acquire lock: another Arbor process is running.";
  await assert.rejects(
    execute(process.execPath, [
      "-e",
      `process.stderr.write(${JSON.stringify(message)});process.exitCode=1;`,
    ]),
    (error) => {
      assert.equal(error.message, message);
      assert.equal(error.stdout, "");
      return true;
    },
  );
});
