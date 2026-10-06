"use strict";

const assert = require("node:assert/strict");

// Tab, rather than programmatic focus: this also finds controls accidentally
// dropped from the tab order. Inspect the active element after every key.
async function focus(t, selector) {
  const name = await t.focused();
  assert.doesNotMatch(name, /^body(?:\.|$)/, `focus fell onto body; wanted ${selector}`);
  assert.equal(await t.js(`document.activeElement.matches(${JSON.stringify(selector)})`), true,
    `wanted ${selector}, focused ${name}`);
  assert.equal(await t.visible(selector), true, `${name} is visible`);
  return name;
}
async function tabTo(t, selector, limit = 80) {
  for (let n = 0; n < limit; n++) {
    if (await t.js(`document.activeElement.matches(${JSON.stringify(selector)})`))
      return focus(t, selector);
    await t.press("Tab");
    const current = await t.focused();
    assert.doesNotMatch(current, /^body(?:\.|$)/, `Tab lost focus while looking for ${selector}`);
    assert.equal(await t.visible(":focus"), true, `${current} is visible`);
  }
  assert.fail(`${selector} is not in the tab order`);
}
async function replace(t, text) {
  await t.press("Control+a");
  await t.type(text);
}
async function open(t, button, dialog, keyboard = false) {
  if (keyboard) { await tabTo(t, button); await t.press("Enter"); }
  else { const p = await t.point(button), zoom = t.page.getZoomFactor(); await t.click({ x: Math.round(p.x * zoom), y: Math.round(p.y * zoom) }); }
  await t.until(() => t.js(`document.querySelector(${JSON.stringify(dialog)}).open`), dialog);
  assert.equal(await t.js(`document.querySelector(${JSON.stringify(dialog)}).matches(':modal')`), true);
  assert.equal(await t.js(`!!document.getElementById(document.querySelector(${JSON.stringify(dialog)}).getAttribute('aria-labelledby'))?.textContent.trim()`), true);
  assert.doesNotMatch(await t.focused(), /^body(?:\.|$)/);
}
async function close(t, button, dialog) {
  await t.press("Escape");
  await t.until(() => t.js(`!document.querySelector(${JSON.stringify(dialog)}).open`), `${dialog} closes`);
  await focus(t, button);
}
async function media(t, features) {
  if (!t.page.debugger.isAttached()) t.page.debugger.attach("1.3");
  await t.page.debugger.sendCommand("Emulation.setEmulatedMedia", { features });
  await t.painted();
}

// Read Chromium's accessibility tree rather than guessing accessible names
// from textContent (which misses label associations and hidden content).
async function accessible(t) {
  if (!t.page.debugger.isAttached()) t.page.debugger.attach("1.3");
  const { nodes } = await t.page.debugger.sendCommand("Accessibility.getFullAXTree");
  const roles = new Set(["button", "checkbox", "radio", "textbox", "searchbox", "combobox", "slider", "treegrid"]);
  const unnamed = nodes.filter(n => !n.ignored && roles.has(n.role?.value) && !n.name?.value?.trim());
  assert.deepEqual(unnamed.map(n => ({ role: n.role.value, id: n.backendDOMNodeId })), [], "interactive elements have accessible names");
  let heading = 1;
  for (const node of nodes.filter(n => !n.ignored && n.role?.value === "heading")) {
    const level = node.properties?.find(p => p.name === "level")?.value?.value;
    assert.ok(node.name?.value?.trim(), "headings have text");
    assert.ok(level <= heading + 1, `heading level jumps from ${heading} to ${level}`);
    heading = level;
  }
  return nodes;
}

// Reads rendered geometry. Intentional scroll containers and tooltip-backed
// ellipses are allowed; hidden overflow without either is not. Sibling controls
// must not overlap. Ancestor/descendant pairs naturally share rectangles.
async function layout(t, root = "body") {
  return t.evaluate((selector) => {
    const scope = document.querySelector(selector);
    const visible = e => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !e.closest('.sr-only');
    const name = e => e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`;
    const elements = [...scope.querySelectorAll('*')].filter(visible);
    const issues = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('page has horizontal overflow');
    const controls = elements.filter(e => e.matches('button,input,select,textarea,summary,[role=slider]'));
    const clipped = e => {
      const b = e.getBoundingClientRect();
      let r = {left: Math.max(0,b.left),right: Math.min(innerWidth,b.right),top: Math.max(0,b.top),bottom: Math.min(innerHeight,b.bottom)};
      for(let p=e.parentElement;p;p=p.parentElement) {
        const s=getComputedStyle(p),q=p.getBoundingClientRect();
        if(s.overflowX!=="visible") {r.left=Math.max(r.left,q.left);r.right=Math.min(r.right,q.right);}
        if(s.overflowY!=="visible") {r.top=Math.max(r.top,q.top);r.bottom=Math.min(r.bottom,q.bottom);}
      }
      return r;
    };
    for (const e of controls) {
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      let scrollX=false, scrollY=false;
      for (let p = e.parentElement; p && p !== scope.parentElement; p = p.parentElement) {
        const s = getComputedStyle(p), r = p.getBoundingClientRect();
        if (!scrollX && s.overflowX === 'hidden' && (b.left < r.left - 2 || b.right > r.right + 2)) issues.push(`${name(e)} clipped horizontally by ${name(p)}`);
        if (!scrollY && s.overflowY === 'hidden' && (b.top < r.top - 2 || b.bottom > r.bottom + 2) && p.scrollHeight <= p.clientHeight + 1) issues.push(`${name(e)} clipped vertically by ${name(p)}`);
        scrollX ||= ["auto","scroll"].includes(s.overflowX);
        scrollY ||= ["auto","scroll"].includes(s.overflowY);
      }
    }
    // Cache geometry once: an audit must not itself stall a large scan.
    const bounds = new Map(controls.map(e => [e, clipped(e)]));
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      const x = bounds.get(a), y = bounds.get(b);
      // Offscreen rows inside a scrolling list are not competing for pixels.
      if (Math.min(x.bottom, y.bottom, innerHeight) - Math.max(x.top, y.top, 0) <= 2) continue;
      if (Math.min(x.right, y.right, innerWidth) - Math.max(x.left, y.left, 0) > 2)
        issues.push(`${name(a)} overlaps ${name(b)}`);
    }
    for (const e of elements) {
      const s = getComputedStyle(e);
      if (s.textOverflow === 'ellipsis' && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.scrollWidth > e.clientWidth + 1 && !e.closest('[title]'))
        issues.push(`${name(e)} truncates without a title`);
    }
    return [...new Set(issues)];
  }, root);
}

// Composite translucent backgrounds and opacity from the root down. Text
// nodes are tested individually, so a parent's text does not hide low-contrast
// muted children. Disabled text is reported separately: WCAG exempts it, but
// the stress requirement deliberately asks us to measure it too.
async function contrast(t, root = "body") {
  return t.evaluate(selector => {
    const rgba = value => {
      const values = value.match(/[\d.]+/g)?.map(Number) || [];
      const scale = value.startsWith("color(srgb ") ? 255 : 1;
      return [(values[0] || 0)*scale, (values[1] || 0)*scale, (values[2] || 0)*scale, values[3] ?? 1];
    };
    const mix = (a, b, alpha = a[3]) => a.slice(0, 3).map((v, i) => v * alpha + b[i] * (1 - alpha));
    const lum = rgb => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
    const results = [];
    for (const e of document.querySelector(selector).querySelectorAll('*')) {
      const field = e.matches('input:not([type=checkbox]):not([type=radio]), textarea, select');
      if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || e.closest('.sr-only') || (!field && ![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))) continue;
      const text = field ? (e.selectedOptions?.[0]?.textContent || e.value || e.placeholder || '') : e.textContent;
      if (!text.trim()) continue;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight) continue;
      const chain = []; for (let p = e; p; p = p.parentElement) chain.unshift(p);
      let bg = [255,255,255], opacity = 1;
      for (const p of chain) { const s = getComputedStyle(p); opacity *= Number(s.opacity); bg = mix(rgba(s.backgroundColor), bg); }
      const s = getComputedStyle(e, field && !e.value && e.placeholder ? '::placeholder' : null), ink = rgba(s.color);
      const fg = mix(ink, bg, ink[3] * opacity), a = lum(fg), b = lum(bg);
      const ratio = (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700);
      results.push({ element: e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`, text: text.trim().slice(0,80), ratio: +ratio.toFixed(2), minimum: large ? 3 : 4.5, disabled: !!e.closest(':disabled'), foreground: s.color, background: bg });
    }
    return results;
  }, root);
}
async function ring(t) {
  const result = await t.js(`(() => { const e = document.activeElement, marked = e.id === 'worktree-grid' ? e.querySelector('.is-current') : e, s = getComputedStyle(marked); return { focused: e.matches(':focus-visible'), width: parseFloat(s.outlineWidth), style: s.outlineStyle, color: s.outlineColor }; })()`);
  assert.equal(result.focused, true);
  assert.ok(result.width >= 2 && result.style !== 'none', JSON.stringify(result));
}
module.exports = { focus, tabTo, replace, open, close, media, accessible, layout, contrast, ring };

// Empty committed trees make --no-checkout both tiny and genuinely clean.
// Spread registrations across repositories to avoid quadratic Git setup work.
function scaleFixture(f, count) {
  const paths = [];
  for (let first = 0; first < count; first += 100) {
    const repo = f.repository(`projects/repo-${String(first / 100).padStart(2,'0')}`, { remote: false });
    repo.git("rm", "-q", "README.md", ".gitignore");
    f.gitWith(f.dated(100), repo.path, "commit", "-qm", "Empty tree for scale");
    for (let i = first; i < Math.min(first + 100, count); i++) {
      const name = `${i < 500 ? 'delete' : 'keep'}-${String(i).padStart(4,'0')}`;
      const target = f.path("projects", `group-${String(first/100).padStart(2,'0')}`, name);
      f.gitWith(f.dated(72), repo.path, "worktree", "add", "--no-checkout", "-qb", name, target, "main");
      paths.push(target);
    }
  }
  f.write("projects/sentinel", "keep outside checkout\n");
  f.preferences();
  return { count, paths };
}
// About three times the serial medians in scripts/perf/results.json. These
// catch regressions in the rendered list; Git operation deadlines stay separate.
const scaleBudgets = {
  100: {
    scanEndToInteractiveMS: 2600,
    selectAllMS: 100,
    searchMS: 350,
    sortMS: 225,
    reviewMS: 300,
    wheelP95MS: 55,
    wheelMaxMS: 55,
    searchInputMaxMS: 30,
    searchLongestTaskMS: 275
  },
  1000: {
    scanEndToInteractiveMS: 3350,
    selectAllMS: 375,
    searchMS: 1100,
    sortMS: 1475,
    reviewMS: 1675,
    wheelP95MS: 105,
    wheelMaxMS: 150,
    searchInputMaxMS: 175,
    searchLongestTaskMS: 900,
    maxResponseMS: 1250
  },
  3000: {
    scanEndToInteractiveMS: 9450,
    selectAllMS: 1025,
    searchMS: 2800,
    sortMS: 5050,
    reviewMS: 5450,
    wheelP95MS: 250,
    wheelMaxMS: 375,
    searchInputMaxMS: 1100,
    searchLongestTaskMS: 1750
  }
};

async function scaleRun(t, { deletion = false } = {}) {
  const numbers = { count: t.world.count };
  const budgets = scaleBudgets[t.world.count <= 100 ? 100 : t.world.count <= 1000 ? 1000 : 3000];
  const within = name => assert.ok(numbers[name] < budgets[name],
    `${name} ${numbers[name]}ms exceeds ${budgets[name]}ms`);
  const initial = await t.state();
  const began = initial.hosts[0]?.progress?.startedAt || Date.parse(initial.report?.scannedAt) || Date.now();
  await t.until(() => t.count(".worktree-row"), "first painted rows", 300000);
  numbers.firstRowsMS = Date.now() - began;
  await t.settled(300000);
  await t.until(async () => await t.count('.worktree-row') === t.world.count, 'all rows painted', 30000);
  const state = await t.state();
  assert.equal(state.report.worktrees.length, t.world.count);
  assert.ok(state.report.worktrees.every(r => r.recommended), "tiny real checkouts are recommended");
  numbers.scanMS = state.report.durationMs;
  await t.press("/"); await focus(t,"#search");
  numbers.scanEndToInteractiveMS = Date.now() - (Date.parse(state.report.scannedAt) + state.report.durationMs);
  assert.ok(numbers.scanMS < 300000, JSON.stringify(numbers));
  within("scanEndToInteractiveMS");
  async function timed(name, work) {
    const start = Date.now(); await work(); numbers[name] = Date.now()-start;
    within(name);
  }
  await tabTo(t,"#worktree-grid");
  await timed("selectAllMS", async () => {
    await t.press("Control+a");
    assert.equal(await t.count('.worktree-row[aria-selected="true"]'), t.world.count);
  });
  await t.press("Escape");
  // The Promise observes frame timestamps; wheel events are still real input.
  const frames = t.js(`new Promise(resolve => { const times = []; let previous; function frame(now) { if (previous !== undefined) times.push(now-previous); previous=now; if(times.length===45) resolve(times); else requestAnimationFrame(frame); } requestAnimationFrame(frame); })`);
  for (let i=0;i<12;i++) await t.wheel("#table-scroll", 300);
  const samples = (await frames).sort((a,b)=>a-b);
  numbers.wheelP95MS = +samples[Math.floor(samples.length*.95)].toFixed(1);
  numbers.wheelMaxMS = +samples.at(-1).toFixed(1);
  within("wheelP95MS");
  within("wheelMaxMS");
  await t.press("/");
  // Time the application's input handler separately from the whole phrase,
  // and observe long tasks so a quick final result cannot hide blocked keys.
  await t.evaluate(() => {
    const field = document.querySelector("#search"), inputs = [], tasks = [];
    let began;
    const start = () => { began = performance.now(); };
    const end = () => inputs.push(performance.now() - began);
    field.addEventListener("input", start, true);
    field.addEventListener("input", end);
    const observer = new PerformanceObserver(list => {
      tasks.push(...list.getEntries().map(entry => entry.duration));
    });
    observer.observe({ type: "longtask" });
    window.finishScaleInputTiming = () => {
      field.removeEventListener("input", start, true);
      field.removeEventListener("input", end);
      tasks.push(...observer.takeRecords().map(entry => entry.duration));
      observer.disconnect();
      delete window.finishScaleInputTiming;
      return {
        searchInputMaxMS: +Math.max(0, ...inputs).toFixed(1),
        searchLongestTaskMS: +Math.max(0, ...tasks).toFixed(1),
      };
    };
  });
  await timed("searchMS", async () => {
    await t.type("delete-0000");
    await t.until(async () => await t.count('.worktree-row') === 1, 'one matching row');
  });
  Object.assign(numbers, await t.js("finishScaleInputTiming()"));
  within("searchInputMaxMS");
  within("searchLongestTaskMS");
  await t.press("Escape");
  await t.until(async () => await t.count('.worktree-row') === t.world.count, 'search cleared');
  await timed("sortMS", () => t.click("#sort-direction"));
  await timed("reviewMS", async () => {
    await t.click("#cleanup-button");
    await t.until(async () => await t.count('.cleanup-item') === t.world.count, 'complete review');
  });
  await t.press("Escape");
  if (deletion) {
    await t.press("/"); await t.type("delete-");
    await t.until(async () => await t.count('.worktree-row') === 500, '500 targets');
    await t.click("#cleanup-button");
    await t.until(async () => await t.count('.cleanup-item') === 500, '500 reviewed');
    const start = Date.now();
    await t.click("#cleanup-confirm");
    const progress = new Set(); let lastAdvance = Date.now(), lastCount = 0;
    const responsive = [];
    await t.until(async () => {
      const before = Date.now();
      const current = await t.state();
      responsive.push(Date.now()-before);
      const done = t.world.count - current.report.worktrees.length;
      if (done > lastCount) { lastAdvance=Date.now(); lastCount=done; }
      assert.ok(Date.now()-lastAdvance < 30000, 'deletion makes progress within 30 seconds');
      const rendered = await t.text('#host-progress-list');
      if (rendered) progress.add(rendered);
      return !current.busy && !current.removing && done===500;
    }, '500 real deletions with a responsive window', 300000);
    await t.settled();
    numbers.delete500MS=Date.now()-start;
    numbers.progressUpdates=progress.size;
    numbers.maxResponseMS=Math.max(...responsive);
    assert.ok(progress.size > 2, 'visible progress advances');
    within("maxResponseMS");
    for (const [i,p] of t.world.paths.entries()) assert.equal(t.fixture.exists(p), i>=500, p);
    assert.equal(t.fixture.read('projects/sentinel'), 'keep outside checkout\n');
    assert.equal(t.fixture.statistics().removedWorktrees, 500);
  }
  console.log(`MEASURE ${JSON.stringify(numbers)}`);
}
module.exports.scaleFixture = scaleFixture;
module.exports.scaleRun = scaleRun;

// Electron's accelerator-style keyCode vocabulary omits ContextMenu. CDP
// dispatches a real platform key event with the Windows virtual key code.
async function menuKey(t) {
  if (!t.page.debugger.isAttached()) t.page.debugger.attach("1.3");
  for (const type of ["keyDown", "keyUp"])
    await t.page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 });
  await t.painted();
}
module.exports.menuKey = menuKey;
