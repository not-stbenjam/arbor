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

test("the CLI's terminal prefix is not part of a message shown in a window", async () => {
  for (const [stderr, shown] of [
    ["arbor: folder does not exist: /work\n", "folder does not exist: /work"],
    // Only the leading prefix is the CLI's; a path may contain the word.
    ["arbor: cannot read /srv/arbor: denied\n", "cannot read /srv/arbor: denied"],
    ["Warning: skipped\narbor: failed\n", "Warning: skipped\narbor: failed"],
  ])
    await assert.rejects(
      execute(process.execPath, [
        "-e",
        `process.stderr.write(${JSON.stringify(stderr)});process.exitCode=1;`,
      ]),
      (error) => {
        assert.equal(error.message, shown);
        return true;
      },
    );
});
