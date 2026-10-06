"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { icons, generate } = require("./icons.cjs");
const root = path.resolve(__dirname, "..");

test("committed Lucide markup and complete license match the pinned package byte for byte", () => {
  const pinned = require("../package.json").devDependencies["lucide-static"];
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
  assert.equal(require("../package-lock.json").packages["node_modules/lucide-static"].version, pinned);
  for (const [file, content] of Object.entries(generate()))
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), content, `${file}: run npm run icons`);
});

test("every renderer icon literal has an entry, including conditional choices", async () => {
  const { icon } = await import("../desktop/renderer/presentation.mjs");
  const renderer = path.join(root, "desktop/renderer");
  let references = 0;
  for (const relative of fs.readdirSync(renderer, { recursive: true })) {
    if (!/\.(?:m?js|html)$/.test(relative) || relative.endsWith(".generated.mjs")) continue;
    const source = fs.readFileSync(path.join(renderer, relative), "utf8");
    const names = [...source.matchAll(/data-icon\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
    // The first argument can also choose between names with a ternary. Calls
    // using a variable are protected by icon()'s error and real-window tests.
    for (const call of source.matchAll(/\bicon\s*\(\s*([^,)]*)/g))
      for (const literal of call[1].matchAll(/(?:^|[?:])\s*["']([^"']+)["']/g)) names.push(literal[1]);
    for (const name of names) {
      references++;
      assert.doesNotThrow(() => icon(name), `${relative}: ${name}`);
    }
  }
  assert.ok(references > 40, "renderer references were found");
  for (const name of Object.keys(icons)) assert.match(icon(name), /stroke-width="2"/);
  assert.throws(() => icon("missing-icon"), /Unknown icon: missing-icon/);
  assert.throws(() => icon("toString"), /Unknown icon: toString/);
  assert.throws(() => icon(undefined), /Unknown icon/);
});

test("scan options is a gear, sidebar controls exist, and Arbor keeps its own mark", async () => {
  const { iconPaths } = await import("../desktop/renderer/icons.generated.mjs");
  const { icon } = await import("../desktop/renderer/presentation.mjs");
  assert.equal(iconPaths.sliders, iconPaths.settings);
  assert.ok(iconPaths["panel-left-close"]);
  assert.ok(iconPaths["panel-left-open"]);
  assert.match(icon("trees"), /M8 21V3m0 5L4 5m4 9-5-4m5 8 5-4M16 3v7m0-4 4-3m-4 7 4-3/);
  assert.match(icon("trees"), /stroke-width="1.65"/);
});
