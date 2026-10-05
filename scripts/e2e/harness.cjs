"use strict";

// Drives the real application the way a person does: the real window, the
// real command-line program and real Git repositories, with real mouse and
// keyboard input. Only what would reach outside the test is replaced: ssh
// runs on this computer (see fixture.cjs), and native dialogs, menus, the
// clipboard and "open" are answered and noted here rather than shown.
//
// A scenario is one file, run by `node scripts/e2e/run.cjs [name…]`:
//
//   const { scenario } = require("./harness.cjs");
//   scenario({
//     name: "deleting what is recommended",
//     // Builds what is on disk before the application first starts. What it
//     // returns is handed to every launch as `t.world` (JSON only).
//     setup(fixture) {
//       const alpha = fixture.repository("projects/alpha");
//       const merged = alpha.worktree("merged");
//       fixture.preferences();            // omit to begin at first-run setup
//       return { merged: merged.path };
//     },
//     // Each entry is one run of the application on the same disk, in order,
//     // so the second sees what the first left behind.
//     launches: [
//       async (t) => {
//         await t.settled();
//         await t.click("#cleanup-button");
//         await t.until(() => t.js("document.querySelector('#cleanup-dialog').open"), "the review opens");
//         await t.click("#cleanup-confirm");
//         await t.until(() => !t.fixture.exists(t.world.merged), "the folder is gone");
//       },
//     ],
//   });
//
// Options: `size: [width, height]` of the window, `timeout` in seconds for
// each launch (120), and a launch may be `{ args: ["--path", folder], run }`
// to start the application with command-line arguments.
//
// What `t` offers is listed at `driver` below. Prefer `t.click`, `t.press`
// and `t.type` (real input, which fails when something covers the target) to
// calling `.click()` in the page, and assert on what a person would see and
// on what is on disk.

const { app, dialog, Menu, shell, clipboard } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const {
  createDirectory,
  removeDirectory,
  assertDirectory,
  createFixture,
  environment,
  REPOSITORY,
} = require("./fixture.cjs");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flags = process.argv.filter((value) => value === "--no-sandbox");
// The scenario's own file, which is what each launch runs again.
const file = path.resolve(
  process.argv.slice(1).find((value) => value.endsWith(".cjs")) || module.parent.filename,
);

function scenario(definition) {
  assert.ok(definition?.name, "a scenario needs a name");
  assert.ok(definition.launches?.length, "a scenario needs at least one launch");
  if (process.env.ARBOR_E2E_LAUNCH === undefined) direct(definition);
  else launch(definition, Number(process.env.ARBOR_E2E_LAUNCH));
}

// The first process: builds the disk, then runs the application once for each
// launch and reports.
async function direct(definition) {
  const directory = createDirectory(definition.name);
  let failure = null;
  try {
    const fixture = createFixture(directory);
    const world = (await definition.setup?.(fixture)) ?? {};
    fs.writeFileSync(path.join(directory, "world.json"), JSON.stringify(world));
    for (let index = 0; index < definition.launches.length && !failure; index++) {
      const entry = definition.launches[index];
      const child = spawn(
        process.execPath,
        [file, ...flags, ...(entry.args || [])],
        {
          env: { ...environment(directory), ARBOR_E2E_LAUNCH: String(index) },
          stdio: "inherit",
        },
      );
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status, signal) => resolve(status ?? signal));
      });
      if (code !== 0) failure = `launch ${index + 1} ended with ${code}`;
    }
  } catch (error) {
    failure = error.stack || String(error);
  }
  if (failure) {
    console.error(`not ok  ${definition.name}: ${failure}`);
    console.error(`        kept for a look: ${directory}`);
  } else {
    console.log(`ok  ${definition.name}`);
    if (process.env.ARBOR_E2E_KEEP) console.log(`    kept: ${directory}`);
    else removeDirectory(directory);
  }
  app.exit(failure ? 1 : 0);
}

// One run of the application, with the scenario's steps for it.
function launch(definition, index) {
  const directory = assertDirectory(process.env.ARBOR_E2E_DIRECTORY);
  const entry = definition.launches[index];
  const run = typeof entry === "function" ? entry : entry.run;
  const label = `${definition.name}, launch ${index + 1}`;
  app.setPath("userData", path.join(directory, "user-data"));
  app.setPath("sessionData", path.join(directory, "user-data", "session"));
  // Started from a script, Electron does not know the application's version.
  app.setVersion(require(path.join(REPOSITORY, "package.json")).version);
  const native = replaceNative();
  let finished = false;
  const finish = async (window, error) => {
    if (finished) return;
    finished = true;
    if (error) {
      console.error(`\n${label}: ${error.stack || error}`);
      await evidence(window, directory, `failure-${index + 1}`, native);
    }
    app.exit(error ? 1 : 0);
  };
  app.once("browser-window-created", (_event, window) => {
    if (definition.size) window.setSize(...definition.size);
    const watchdog = setTimeout(
      () => finish(window, new Error("the launch ran out of time")),
      (definition.timeout || 120) * 1000,
    );
    const page = window.webContents;
    page.on("console-message", (...args) => {
      const details = args.find((value) => value && typeof value === "object" && "message" in value);
      const level = details?.level ?? args[1], message = String(details?.message ?? args[2]);
      native.console.push({ level, message });
    });
    page.once("did-fail-load", (_e, code, description) =>
      finish(window, new Error(`the window did not load: ${code} ${description}`)),
    );
    page.once("did-finish-load", async () => {
      try {
        const t = driver({ window, directory, native, index });
        await t.until(() => t.js("!!window.arbor"), "the application's bridge");
        await run(t);
        const errors = native.console.filter(
          ({ level, message }) =>
            (level === 3 || level === "error") && !t.allowed.some((pattern) => pattern.test(message)),
        );
        assert.deepEqual(errors.map((entry) => entry.message), [], "the window logged errors");
        assert.deepEqual(native.unanswered, [], "a native dialog nobody answered");
        clearTimeout(watchdog);
        await finish(window);
      } catch (error) {
        clearTimeout(watchdog);
        await finish(window, error);
      }
    });
  });
  require(path.join(REPOSITORY, "desktop", "main.cjs"));
}

// Replaces what would otherwise appear outside the window or reach outside
// the test, and keeps a note of each use.
function replaceNative() {
  const native = {
    console: [],
    // Each message box shown: { type, message, detail, buttons, answered }.
    messages: [],
    answers: [],
    unanswered: [],
    // Folder choosers shown, and what to answer the next ones with.
    choosers: [],
    folders: [],
    errors: [],
    // The latest right-click menu, as the template it was built from.
    menu: null,
    menus: 0,
    opened: [],
    clipboard: null,
  };
  dialog.showMessageBox = async (...args) => {
    const options = args.find((value) => value && typeof value === "object" && "message" in value) || {};
    const record = {
      type: options.type || "none",
      title: options.title || "",
      message: options.message || "",
      detail: options.detail || "",
      buttons: options.buttons || [],
      checkbox: options.checkboxLabel || "",
    };
    native.messages.push(record);
    if (!native.answers.length) {
      // Nobody said what to press: say so, and press whatever cancels.
      native.unanswered.push(record.message);
      return { response: options.cancelId ?? 0, checkboxChecked: false };
    }
    let answer = native.answers.shift();
    if (typeof answer === "function") answer = await answer(record);
    if (typeof answer === "string") {
      const at = record.buttons.findIndex((button) => button.replace(/&/g, "") === answer);
      assert.ok(at >= 0, `no "${answer}" button among ${JSON.stringify(record.buttons)}`);
      answer = at;
    }
    record.answered = record.buttons[answer] ?? answer;
    return { response: answer, checkboxChecked: false };
  };
  dialog.showOpenDialog = async (...args) => {
    const options = args.find((value) => value && typeof value === "object" && !value.webContents) || {};
    native.choosers.push(options);
    const folder = native.folders.shift();
    return folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] };
  };
  dialog.showErrorBox = (title, content) => native.errors.push({ title, content });
  for (const name of ["openExternal", "openPath", "showItemInFolder"])
    shell[name] = (target) => {
      native.opened.push({ how: name, target });
      return name === "openPath" ? Promise.resolve("") : name === "openExternal" ? Promise.resolve() : undefined;
    };
  clipboard.writeText = (text) => {
    native.clipboard = text;
  };
  const build = Menu.buildFromTemplate.bind(Menu);
  Menu.buildFromTemplate = (template) => {
    const menu = build(template);
    // A menu the application pops up is kept to choose from, not shown.
    menu.popup = () => {
      native.menu = menu;
      native.menus++;
    };
    return menu;
  };
  return native;
}

// A picture of the window. One asked for before the window has first been
// drawn fails, so this waits for it and asks again.
async function capture(window) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (!window.isVisible()) throw new Error("the window is not shown yet");
      const image = await window.webContents.capturePage();
      if (!image.isEmpty()) return image;
      throw new Error("the picture was empty");
    } catch (error) {
      if (attempt >= 40) throw error;
      await pause(100);
    }
  }
}

async function evidence(window, directory, name, native) {
  try {
    if (!window || window.isDestroyed()) return;
    const shot = path.join(directory, `${name}.png`);
    fs.writeFileSync(shot, (await capture(window)).toPNG());
    fs.writeFileSync(
      path.join(directory, `${name}.html`),
      await window.webContents.executeJavaScript("document.documentElement.outerHTML"),
    );
    console.error(`        picture: ${shot}`);
    const said = native.console.slice(-12).map((entry) => `          ${entry.message}`);
    if (said.length) console.error(`        the window's console:\n${said.join("\n")}`);
    for (const message of native.messages.slice(-3))
      console.error(`        dialog: ${message.message} ${JSON.stringify(message.buttons)}`);
  } catch {
    /* The window is already gone. */
  }
}

const KEYS = { Space: " ", Esc: "Escape", Del: "Delete", Return: "Enter" };
const CHARACTERS = { Enter: "\r", Tab: "\t", " ": " " };

function driver({ window, directory, native, index }) {
  const page = window.webContents;
  const fixture = createFixture(directory);
  const js = (source) => page.executeJavaScript(source);
  // Runs `fn` in the page with JSON arguments: t.evaluate((id) => …, "x").
  const evaluate = (fn, ...args) =>
    js(`(${fn})(...${JSON.stringify(args)})`);

  async function until(check, description, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let last, problem;
    for (;;) {
      try {
        last = await check();
        problem = null;
        if (last) return last;
      } catch (error) {
        problem = error;
      }
      if (Date.now() > deadline)
        throw new Error(`Still waiting after ${timeout / 1000}s for: ${description}${problem ? ` (${problem.message})` : ""}`);
      await pause(40);
    }
  }
  // Two painted frames: enough for the page to have reacted to input.
  const painted = () =>
    js("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))");

  // Where a person would click for `target`: a selector, or { x, y }.
  // A target that is hidden, or has something else on top of its middle,
  // is an error, because a person could not click it either.
  async function point(target, { covered = false } = {}) {
    if (typeof target !== "string") return target;
    const found = await evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { problem: "is not in the page" };
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return { problem: "has no size (hidden?)" };
      const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2);
      const hit = document.elementFromPoint(x, y);
      const name = (node) =>
        node ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${node.classList.length ? `.${[...node.classList].join(".")}` : ""}` : "nothing";
      return {
        x,
        y,
        disabled: element.disabled === true,
        hit: !!hit && (hit === element || element.contains(hit)),
        over: name(hit),
      };
    }, target);
    if (found.problem) throw new Error(`${target} ${found.problem}`);
    if (!found.hit && !covered)
      throw new Error(`${target} is covered by ${found.over} at ${found.x},${found.y}`);
    return found;
  }

  const modifiersOf = (options = {}) =>
    ["shift", "control", "alt", "meta"].filter((name) => options[name]);

  // A real click. Options: shift, control, alt, meta, button ("left"), count (1).
  async function click(target, options = {}) {
    const { x, y } = await point(target, options);
    const button = options.button || "left", modifiers = modifiersOf(options);
    page.sendInputEvent({ type: "mouseMove", x, y, modifiers });
    for (let count = 1; count <= (options.count || 1); count++) {
      page.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: count, modifiers });
      page.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: count, modifiers });
    }
    await painted();
  }
  async function hover(target) {
    const { x, y } = await point(target, { covered: true });
    page.sendInputEvent({ type: "mouseMove", x, y });
    await painted();
  }
  // Presses at `from`, moves to `to` in a few steps, and releases.
  async function drag(from, to, options = {}) {
    const a = await point(from, { covered: true }), b = await point(to, { covered: true });
    const modifiers = modifiersOf(options);
    page.sendInputEvent({ type: "mouseMove", x: a.x, y: a.y, modifiers });
    page.sendInputEvent({ type: "mouseDown", x: a.x, y: a.y, button: "left", clickCount: 1, modifiers });
    for (let step = 1; step <= 6; step++)
      page.sendInputEvent({
        type: "mouseMove",
        x: Math.round(a.x + ((b.x - a.x) * step) / 6),
        y: Math.round(a.y + ((b.y - a.y) * step) / 6),
        button: "left",
        modifiers: [...modifiers, "leftButtonDown"],
      });
    page.sendInputEvent({ type: "mouseUp", x: b.x, y: b.y, button: "left", clickCount: 1, modifiers });
    await painted();
  }
  async function wheel(target, deltaY, deltaX = 0) {
    const { x, y } = await point(target, { covered: true });
    page.sendInputEvent({ type: "mouseWheel", x, y, deltaX: -deltaX, deltaY: -deltaY, canScroll: true });
    await painted();
  }

  // A real key press, to whatever has the keyboard: "Enter", "ArrowDown",
  // "Shift+Tab", "Control+a", "Meta+f", "Space", "Escape", "a".
  async function press(combination, { times = 1 } = {}) {
    const parts = combination === "+" ? ["+"] : combination.split("+");
    let key = parts.pop();
    key = KEYS[key] || key;
    const modifiers = parts.map((part) => part.toLowerCase());
    const character = CHARACTERS[key] ?? (key.length === 1 ? key : null);
    const typed = character !== null && !modifiers.some((name) => name !== "shift");
    for (let count = 0; count < times; count++) {
      page.sendInputEvent({ type: "keyDown", keyCode: key === " " ? "Space" : key, modifiers });
      if (typed) page.sendInputEvent({ type: "char", keyCode: character, modifiers });
      page.sendInputEvent({ type: "keyUp", keyCode: key === " " ? "Space" : key, modifiers });
      await painted();
    }
  }
  // Types text into whatever has the keyboard, a key at a time.
  async function type(text) {
    for (const character of String(text)) {
      page.sendInputEvent({ type: "keyDown", keyCode: character });
      page.sendInputEvent({ type: "char", keyCode: character });
      page.sendInputEvent({ type: "keyUp", keyCode: character });
    }
    await painted();
  }
  // Clicks into a field, replaces what it holds, and leaves the keyboard there.
  async function fill(selector, text) {
    await click(selector);
    await evaluate((target) => document.querySelector(target).select?.(), selector);
    if (text === "") await press("Delete");
    else await type(text);
  }

  // The page forbids evaluating text as code, so `read` is written into the
  // script itself rather than passed to it.
  const one = (selector, read) =>
    js(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element ? (${read})(element) : null; })()`);
  const state = () => js("window.arbor.getState()");

  const t = {
    // What `setup` returned.
    world: JSON.parse(fs.readFileSync(path.join(directory, "world.json"), "utf8")),
    // The same fixture `setup` was given: its repositories, `git`, `cli`,
    // `exists`, `cliCalls`, `connections`, `opened`, `statistics`…
    fixture,
    // Which launch this is, counting from 0.
    launch: index,
    window,
    page,
    assert,
    pause,
    js,
    evaluate,
    until,
    painted,
    point,
    click,
    hover,
    drag,
    wheel,
    press,
    type,
    fill,
    // The application's own state, as its window sees it.
    state,
    // Waits until nothing is being scanned or deleted and the list is drawn.
    async settled(timeout = 30000) {
      return until(
        async () => {
          const current = await state();
          if (current.busy || current.setupRequired) return false;
          if ((current.hosts || []).some((host) => host.scanning || host.busy)) return false;
          return (await js("!document.querySelector('#scan-progress:not([hidden])')")) && current;
        },
        "the application to finish what it is doing",
        timeout,
      );
    },
    // The first matching element's text as shown, or null when there is none.
    text: (selector) => one(selector, (element) => element.innerText.trim()),
    value: (selector) => one(selector, (element) => element.value),
    attribute: (selector, name) =>
      evaluate((target, attribute) => document.querySelector(target)?.getAttribute(attribute) ?? null, selector, name),
    exists: (selector) => evaluate((target) => !!document.querySelector(target), selector),
    count: (selector) => evaluate((target) => document.querySelectorAll(target).length, selector),
    texts: (selector) =>
      evaluate((target) => [...document.querySelectorAll(target)].map((element) => element.innerText.trim()), selector),
    // Whether a person can see it: in the page, not hidden, with a size, and
    // inside the window.
    visible: (selector) =>
      evaluate((target) => {
        const element = document.querySelector(target);
        if (!element || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
      }, selector),
    enabled: (selector) => one(selector, (element) => !element.disabled && element.getAttribute("aria-disabled") !== "true"),
    checked: (selector) => one(selector, (element) => element.checked === true),
    // What has the keyboard, as "tag#id.class".
    focused: () =>
      js(`(() => { const e = document.activeElement; return e ? e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].join(".") : "") : ""; })()`),
    // The rows of the worktree list as shown, top to bottom:
    // { id, text, ticked, current, folder }.
    rows: () =>
      js(`[...document.querySelectorAll("#worktree-list tr")].filter((row) => row.checkVisibility()).map((row) => ({
        id: row.dataset.id || "",
        folder: !row.dataset.id,
        text: row.innerText.replace(/\\s+/g, " ").trim(),
        ticked: !!row.querySelector("input[type=checkbox]")?.checked,
        current: row.classList.contains("is-current"),
      }))`),
    // The worktree the application reports at this folder, or undefined.
    async worktree(folder) {
      const current = await state();
      return (current.report?.worktrees || current.partialWorktrees || []).find((row) => row.path === folder);
    },
    // A selector for the list row of the worktree at this folder.
    async row(folder) {
      const found = await until(() => t.worktree(folder), `a row for ${folder}`);
      return `#worktree-list tr[data-id="${found.id.replace(/["\\]/g, "\\$&")}"]`;
    },

    // Native dialogs. Say beforehand what the next message box is answered
    // with: a button's label, its number, or a function given the box.
    answer: (...answers) => native.answers.push(...answers),
    // The message boxes shown so far (see replaceNative).
    messages: native.messages,
    // Makes the next folder chooser return this folder (none: it is cancelled).
    choose: (...folders) => native.folders.push(...folders),
    choosers: native.choosers,
    // Console errors matching one of these do not fail the scenario.
    allowed: [],
    native,
    // Right-clicks, and returns the labels of the menu that would have appeared.
    async contextMenu(target, options = {}) {
      const before = native.menus;
      await click(target, { ...options, button: "right" });
      await until(() => native.menus > before, "a right-click menu");
      return native.menu.items.map((item) => ({
        label: item.label,
        enabled: item.enabled,
        separator: item.type === "separator",
      }));
    },
    // Chooses an item of the menu `contextMenu` last brought up.
    async chooseMenu(label) {
      const item = native.menu?.items.find((entry) => entry.label === label);
      assert.ok(item, `no "${label}" in the menu: ${native.menu?.items.map((entry) => entry.label).join(", ")}`);
      assert.ok(item.enabled, `"${label}" is disabled`);
      item.click(item, window, {});
      await painted();
    },
    // Chooses from the application menu by labels: t.menu("File", "Refresh Worktrees").
    async menu(...labels) {
      let items = Menu.getApplicationMenu().items, item;
      for (const label of labels) {
        item = items.find((entry) => entry.label === label);
        assert.ok(item, `no "${label}" in ${items.map((entry) => entry.label).join(", ")}`);
        items = item.submenu?.items || [];
      }
      assert.ok(item.enabled, `"${labels.join(" > ")}" is disabled`);
      item.click(item, window, {});
      await painted();
    },
    // Every item of the application menu: { path, accelerator, enabled }.
    menuItems() {
      const walk = (items, trail) =>
        items.flatMap((item) =>
          item.type === "separator"
            ? []
            : [
                { path: [...trail, item.label], accelerator: item.accelerator || "", enabled: item.enabled, role: item.role || "" },
                ...walk(item.submenu?.items || [], [...trail, item.label]),
              ],
        );
      return walk(Menu.getApplicationMenu().items, []);
    },
    clipboard: () => native.clipboard,
    // What the application asked the system to open: { how, target }.
    opened: native.opened,
    // Saves a picture of the window beside the fixture (or in
    // $ARBOR_E2E_ARTIFACTS) and returns where.
    async screenshot(name) {
      const folder = process.env.ARBOR_E2E_ARTIFACTS || path.join(directory, "pictures");
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${name}.png`);
      fs.writeFileSync(file, (await capture(window)).toPNG());
      return file;
    },
    // Resizes the window's content and waits for the page to lay out.
    async resize(width, height) {
      window.setContentSize(width, height);
      await until(() => js(`innerWidth === ${width} && innerHeight === ${height}`), `a ${width}×${height} window`);
      await painted();
    },
    async zoom(factor) {
      page.setZoomFactor(factor);
      await painted();
    },
    // Names a part of the scenario in the output, so a failure says where.
    async step(description, body) {
      const started = Date.now();
      try {
        const result = await body();
        console.log(`    ✓ ${description} (${Date.now() - started} ms)`);
        return result;
      } catch (error) {
        error.message = `${description}: ${error.message}`;
        throw error;
      }
    },
  };
  return t;
}

module.exports = { scenario, assert, pause };
