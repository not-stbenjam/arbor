"use strict";

// Run through the real-Git harness, serially. ARBOR_PERF_PROFILE=1 adds CPU
// samples and layout/style counters; omit it for comparable wall timings.
const fs = require("node:fs");
const path = require("node:path");
const { scenario } = require("../e2e/harness.cjs");
const { scaleFixture, scaleRun } = require("../e2e/stress-helpers.cjs");
const count = Number(process.env.ARBOR_PERF_COUNT || 1000);
scenario({
  name: `profile ${count} worktrees`, timeout: 600,
  setup: f => scaleFixture(f, count),
  launches: [async t => {
    let profileWork;
    if (process.env.ARBOR_PERF_CSS)
      await t.evaluate(rule => document.styleSheets[0].insertRule(rule), process.env.ARBOR_PERF_CSS);
    if (process.env.ARBOR_PERF_PROFILE) {
      const cdp = t.page.debugger;
      cdp.attach("1.3");
      await cdp.sendCommand("Profiler.enable");
      await cdp.sendCommand("Performance.enable");
      async function profile(name, work) {
        const metrics = async () => Object.fromEntries((await cdp.sendCommand("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
        const before = await metrics();
        await cdp.sendCommand("Profiler.start");
        const start = Date.now();
        const result = await work();
        const elapsed = Date.now() - start;
        const { profile } = await cdp.sendCommand("Profiler.stop");
        const after = await metrics();
        const nodes = new Map(profile.nodes.map(n => [n.id, n.callFrame]));
        const costs = new Map();
        (profile.samples || []).forEach((id, i) => {
          const frame = nodes.get(id);
          const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber + 1}`;
          costs.set(key, (costs.get(key) || 0) + profile.timeDeltas[i] / 1000);
        });
        const summary = { name, count, elapsed, browser: Object.fromEntries(['LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration'].map(k => [k, Math.round((after[k]-before[k])*1000)])), top: [...costs].sort((a,b) => b[1]-a[1]).slice(0,12) };
        console.log(`PROFILE ${JSON.stringify(summary)}`);
        if (process.env.ARBOR_PERF_OUTPUT) {
          fs.mkdirSync(process.env.ARBOR_PERF_OUTPUT, { recursive: true });
          fs.writeFileSync(path.join(process.env.ARBOR_PERF_OUTPUT, `${count}-${name}.cpuprofile`), JSON.stringify(profile));
        }
        return result;
      }
      profileWork = profile;
      for (const [method, match] of [
        ['settled', () => 'scan-settle'],
        ['press', key => key === 'Control+a' && 'select-all'],
        ['type', () => 'search'],
        ['click', target => ({ '#sort-direction': 'sort', '#cleanup-button': 'review' })[target]],
      ]) {
        const original = t[method];
        t[method] = (...args) => {
          const name = match(...args);
          return name ? profile(name, () => original(...args)) : original(...args);
        };
      }
    }
    await scaleRun(t);
    if (profileWork) {
      const cdp = t.page.debugger;
      const events = [];
      const collected = (_event, method, params) => {
        if (method === "Tracing.dataCollected") events.push(...params.value);
      };
      cdp.on("message", collected);
      await cdp.sendCommand("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
      await profileWork("wheel", async () => {
        for (let i = 0; i < 12; i++) await t.wheel("#table-scroll", 300);
      });
      const complete = new Promise(resolve => {
        const listener = (_event, method) => {
          if (method !== "Tracing.tracingComplete") return;
          cdp.off("message", listener);
          resolve();
        };
        cdp.on("message", listener);
      });
      await cdp.sendCommand("Tracing.end");
      await complete;
      cdp.off("message", collected);
      const costs = new Map();
      for (const event of events) if (event.ph === "X" && event.dur)
        costs.set(event.name, (costs.get(event.name) || 0) + event.dur / 1000);
      console.log(`TRACE ${JSON.stringify({ name: "wheel", count, inclusiveMS: [...costs].sort((a,b) => b[1]-a[1]).slice(0,15) })}`);
    }
  }],
});
