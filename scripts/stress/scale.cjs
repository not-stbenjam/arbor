"use strict";
const { main, scenario, assert, fs, path, ok, start } = require("./helpers.cjs");
const { measurement } = require("./measure.cjs");
main(async () => {
  const sizes = (process.env.STRESS_SCALE || "1000,5000").split(",").map(Number);
  for (const count of sizes) await scenario(`scale-${count}`, async (f) => {
    const repositories = Math.ceil(count / 100);
    for (let r = 0, added = 0; r < repositories; r++) {
      const repo = f.repository(`projects/r-${r}`, { remote: false });
      for (let n = 0; n < 100 && added < count; n++, added++) {
        const target = f.path("projects", `trees-${r}`, `w-${n}`);
        f.gitWith(f.dated(72), repo.path, "worktree", "add", "--no-checkout", "-b", `topic-${n}`, target);
        // Keep a real index but omit checkout files. These are intentionally
        // dirty worktrees, removed only by the explicit forced batch.
        f.git(target, "read-tree", "HEAD");
      }
    }
    // Lots of directories/files add discovery pressure without allocating data.
    const files = count * 10;
    const source = f.write("payload", "x");
    for (let i = 0; i < files; i++) {
      const dest = f.path("projects", "deep", ...Array(12).fill("level"), String(Math.floor(i / 100)), `f-${i}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.linkSync(source, dest);
    }
    fs.mkdirSync(f.path("projects", "excluded"));
    const huge = f.path("projects", "excluded", "huge"); const fd = fs.openSync(huge, "w"); fs.ftruncateSync(fd, 2 ** 32); fs.closeSync(fd);
    for (const command of ["list", "clean"]) {
      const timing = f.path(`time-${command}`);
      const began = performance.now();
      let lastProgress = began, maxProgressGapMs = 0;
      const meter = measurement(timing, f.env.ARBOR_CLI_PATH, [command, "--path", f.root, "--json", "--progress", "--exclude", "excluded", ...(command === "clean" ? ["--all", "--force", "--yes"] : [])]);
      const result = ok(await start(f, meter.args, { command: meter.command, timeout: 1800000,
        output(chunk, stderr) {
          if (stderr && chunk.includes("@arbor-progress ")) {
            const now = performance.now(); maxProgressGapMs = Math.max(maxProgressGapMs, now - lastProgress); lastProgress = now;
          }
        },
      }).done);
      const seconds = (performance.now() - began) / 1000;
      const value = JSON.parse(result.stdout);
      assert.equal(command === "list" ? value.worktrees.length : value.filter((x) => x.removed).length, count);
      const events = result.stderr.split("\n").filter((s) => s.startsWith("@arbor-progress ")).map((s) => JSON.parse(s.slice(16)));
      assert.ok(events.some((e) => e.stage === "inspect" && e.completed === count));
      const completed = events.filter((e) => e.stage === "inspect").map((e) => e.completed);
      assert.ok(completed.every((v, i) => i === 0 || v >= completed[i - 1]));
      const rss = Number(fs.readFileSync(timing, "utf8").match(/Maximum resident set size \(kbytes\): (\d+)/)[1]);
      console.log(`MEASURE ${JSON.stringify({ meter: meter.meter, worktrees: count, repositories, files: files + count, command, seconds: +seconds.toFixed(3), peakKiB: rss, progressEvents: events.length, maxProgressGapMs: Math.round(maxProgressGapMs) })}`);
    }
    assert.ok(f.exists(huge)); assert.equal(f.statistics().removedWorktrees, count);
  });
});
