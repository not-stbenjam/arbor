"use strict";

// The promotional video, as a page that can show itself at any moment.
// `window.__seek(t)` puts every element where it belongs at time t, in
// seconds. Nothing runs by the clock: the renderer asks for one frame after
// another, however long each takes to draw.
//
// The application in the middle of it is the real one, in a frame, running
// on an invented workspace (see ../mock-preload.cjs). Its buttons are really
// pressed, at the moments the timeline says, so moments must be asked for in
// order.

const T = window.TIMELINE;
const $ = (selector) => document.querySelector(selector);
const clamp = (x, low = 0, high = 1) => Math.min(high, Math.max(low, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = {
  linear: (x) => x,
  in: (x) => x * x * x,
  out: (x) => 1 - (1 - x) ** 3,
  out5: (x) => 1 - (1 - x) ** 5,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  inOut5: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  // Past its mark and back, once: for things that arrive.
  back: (x) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2,
  // A weight on a spring, settling.
  spring: (x) => 1 - Math.exp(-7 * x) * Math.cos(9.5 * x),
};
// How far t is from a to b, eased, held at 0 before and 1 after.
const span = (t, a, b, curve = ease.out) => curve(clamp((t - a) / (b - a)));
// There between a and b, with a moment to arrive and a moment to leave.
const present = (t, a, b, arrive = 0.35, leave = 0.3) =>
  Math.min(span(t, a, a + arrive), 1 - span(t, b - leave, b, ease.in));
// A value through keys of [time, value, curve into this key]. Between two
// keys with the same value nothing moves: the camera holds while something
// is read.
function through(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [at, value, curve = ease.inOut] = keys[i];
    if (t <= at) {
      const [from, start] = keys[i - 1];
      const k = curve(clamp((t - from) / (at - from)));
      return Array.isArray(value) ? value.map((v, n) => lerp(start[n], v, k)) : lerp(start, value, k);
    }
  }
  return keys.at(-1)[1];
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(test, what) {
  for (let i = 0; i < 600; i++) {
    if (test()) return;
    await wait(8);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- the app --

const appWindow = () => $("#app").contentWindow;
const inApp = (selector) => $("#app").contentDocument.querySelector(selector);
const allInApp = (selector) => [...$("#app").contentDocument.querySelectorAll(selector)];
// Where something in the application is, in the window's own coordinates.
function place(element) {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height, cx: box.left + box.width / 2, cy: box.top + box.height / 2 };
}
const rowNamed = (name) => allInApp(".worktree-row").find((row) => row.dataset.path.endsWith(`/${name}`));
const union = (...boxes) => {
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

const workspace = window.__workspace;
const recommended = workspace.filter((row) => row.recommended);
const GB = 1024 ** 3;

// Places in the application the camera and the pointer go to. Each is noted
// while it is there to be measured and kept after it has gone: the review
// closes the instant its button is pressed, and the picture must not jump.
let shots = null;

// What happens in the application, and when. Each is done once, in order.
const cues = [
  {
    at: T.review.hover,
    run: () => inApp("#cleanup-button").classList.add("promo-hover-cleanup"),
  },
  {
    at: T.review.click,
    run: async () => {
      inApp("#cleanup-button").classList.remove("promo-hover-cleanup");
      inApp("#cleanup-button").click();
      await until(() => inApp("#cleanup-dialog").open, "the review");
      // Opened by a pointer, it shows no keyboard ring.
      $("#app").contentDocument.activeElement?.blur();
      shots.dialog = place(inApp("#cleanup-dialog"));
      shots.confirm = place(inApp("#cleanup-confirm"));
      const reason = inApp(".cleanup-reason");
      shots.reason = place(reason.firstElementChild || reason);
    },
  },
  {
    at: T.review.hover2,
    run: () => inApp("#cleanup-confirm").classList.add("promo-hover-danger"),
  },
  {
    at: T.review.click2,
    run: async () => {
      inApp("#cleanup-confirm").classList.remove("promo-hover-danger");
      inApp("#cleanup-confirm").click();
      await until(() => appWindow().__backend.removal, "the deletion to be asked for");
      $("#app").contentDocument.activeElement?.blur();
    },
  },
  {
    at: T.delete.toast,
    run: async () => {
      // Every worktree has gone before the word comes that all have, even
      // when the moments between were not asked for.
      await applyDeletion(T.delete.toast - 0.001);
      appWindow().__backend.finish();
      await until(() => inApp(".toast"), "the notification");
    },
  },
];
let nextCue = 0;

// Invented files for the deletion to be seen working through. They are the
// kind a repository tracks: these worktrees are clean, with nothing ignored
// in them, so there are no dependency folders or build output to delete.
const FILES = {
  api: [
    "internal/billing/invoice_test.go",
    "db/migrations/0412_add_oauth_tokens.sql",
    "testdata/fixtures/customers-large.json",
    "docs/openapi/v2.yaml",
    "internal/ratelimit/window.go",
    "testdata/recordings/checkout-flow.har",
    "cmd/server/main.go",
    "web/static/img/dashboard@2x.png",
  ],
  web: [
    "src/components/Checkout/Summary.tsx",
    "public/media/hero-dark@2x.webp",
    "e2e/fixtures/catalog.json",
    "src/styles/tokens.css",
    "public/video/onboarding-tour.mp4",
    "src/pages/settings/appearance.tsx",
    "e2e/snapshots/checkout-safari.png",
    "content/guides/getting-started.mdx",
  ],
  mobile: [
    "ios/App/Assets.xcassets/Launch.imageset/launch@3x.png",
    "android/app/src/main/res/raw/onboarding.mp4",
    "shared/notifications/PushRouter.kt",
    "ios/App/Notifications/PushHandler.swift",
    "fixtures/screenshots/pixel-8/inbox.png",
    "android/app/src/main/res/font/inter_variable.ttf",
    "shared/sync/OfflineQueue.kt",
    "ios/AppTests/Fixtures/timeline.json",
  ],
  infra: [
    "modules/network/main.tf",
    "environments/staging/terraform.tfvars",
    "modules/cluster/variables.tf",
    "docs/runbooks/failover.md",
    "policies/iam/deploy-role.json",
    "modules/database/outputs.tf",
  ],
};
// How far the deletion has got at time t.
function deletion(t) {
  const done = T.delete.done;
  const finished = done.filter((at) => at <= t).length;
  const order = appWindow().__backend.removal || [];
  const from = finished ? done[finished - 1] : T.delete.start + 0.12,
    to = done[finished] ?? T.delete.toast;
  const index = Math.min(finished, order.length - 1);
  const row = recommended.find((entry) => entry.id === order[index]?.id) || recommended[0];
  const filesTotal = Math.round(row.bytes / 180000 / 10) * 10 + 7 * (index + 3);
  const all = finished >= order.length;
  const within = all ? 1 : clamp((t - from) / (to - from));
  const names = FILES[row.repo] || FILES.api;
  return {
    completed: Math.min(finished, order.length),
    files: all ? 0 : Math.min(filesTotal, Math.floor(filesTotal * ease.inOut(within))),
    filesTotal: all ? 0 : filesTotal,
    file: all ? "" : names[Math.floor(t * 17) % names.length],
    index,
    gone: order.slice(0, finished).map((item) => item.id),
  };
}
// What the worktrees deleted so far held: the estimate the application
// itself gives when it is done, a worktree at a time.
function recovered(t) {
  const order = appWindow().__backend?.removal;
  const ids = order ? order.map((item) => item.id) : recommended.map((row) => row.id);
  let total = 0;
  T.delete.done.forEach((at, i) => {
    const bytes = recommended.find((row) => row.id === ids[i])?.bytes || 0;
    total += bytes * span(t, at, at + 0.32, ease.out);
  });
  return total;
}
let shownProgress = "";
// Where each worktree is, noted while its row is still there to ask.
const pathOf = new Map();
async function applyDeletion(t) {
  const backend = appWindow().__backend;
  if (!backend.removal || t >= T.delete.toast) return;
  const now = deletion(t);
  const key = JSON.stringify([now.completed, now.files, now.file]);
  if (key === shownProgress) return;
  shownProgress = key;
  backend.progress({
    completed: now.completed,
    files: now.files,
    filesTotal: now.filesTotal,
    file: now.file,
    path: pathOf.get(backend.removal[now.index].id) || "",
    gone: now.gone,
  });
  const count = now.filesTotal ? `${now.files.toLocaleString()} of ${now.filesTotal.toLocaleString()} files` : "";
  await until(
    () =>
      (inApp(".host-progress-count")?.textContent || "") === count &&
      (inApp(".host-progress-file")?.textContent || "") === now.file &&
      allInApp(".worktree-row").length === workspace.length - now.gone.length,
    `deletion progress at ${t}`,
  );
}

// ------------------------------------------------------------- the stage --

// Words that arrive one after another. A line break is kept as one.
function words(element, text) {
  element.innerHTML = text
    .split(/(\s+)/)
    .map((part) => (part.includes("\n") ? "<br />" : /^\s+$/.test(part) ? part : `<span class="word">${part}</span>`))
    .join("");
  return [...element.querySelectorAll(".word")];
}
function arrive(list, t, start, { step = 0.07, rise = 34, length = 0.6 } = {}) {
  list.forEach((word, i) => {
    const k = span(t, start + i * step, start + i * step + length, ease.out5);
    word.style.opacity = k;
    word.style.transform = `translateY(${(1 - k) * rise}px)`;
    word.style.filter = k < 1 ? `blur(${(1 - k) * 10}px)` : "none";
  });
}

const BRANCH = '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-3h6a6 6 0 0 0 6-6"/></svg>';
// Around the edge of the stage, leaving the middle for the words.
const SEATS = [
  [34, 78], [406, 104], [778, 70], [1150, 100], [1522, 76],
  [96, 252], [1452, 256],
  [22, 486], [1526, 492],
  [110, 722], [1440, 716],
  [200, 898], [576, 916], [968, 902], [1344, 912],
];
const ORDER = [7, 2, 12, 9, 0, 14, 5, 3, 10, 8, 1, 13, 6, 11, 4];
// The same irregularity every time the video is drawn.
const wobble = (n, salt) => {
  const x = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};
const sizeOf = (bytes) => (bytes < GB ? `${Math.round(bytes / 1024 ** 2)} MB` : `${(bytes / GB).toFixed(1)} GB`);
const chips = workspace.map((row, i) => {
  const chip = document.createElement("div");
  chip.className = "chip";
  chip.innerHTML = `${BRANCH}<div><b>${row.name}</b><small>${row.repo} · ${row.branch}</small></div><em>${sizeOf(row.bytes)}</em>`;
  $("#chips").append(chip);
  const [x, y] = SEATS[ORDER[i]];
  return { chip, row, x: x - 13 + wobble(i, 1) * 16, y: y + wobble(i, 2) * 14, turn: wobble(i, 3) * 2.2, at: T.pile.chips[i] };
});

const lineA = words($("#pile-line-a"), "Another branch.\nAnother worktree.");
const lineB = words($("#pile-line-b"), "They pile up.");
const leaves = [...document.querySelectorAll("#mark .leaf")];
leaves.forEach((leaf) => {
  const [x, y] = leaf.dataset.origin.split(" ");
  leaf.style.transformOrigin = `${x}px ${y}px`;
});
$("#tagline").textContent = "Git worktrees, under control.";
// Where the mark will stand when the name arrives: what the pile is drawn to.
$("#brand-row").style.top = "372px";
const markAt = $("#mark").getBoundingClientRect();
const MARK = { x: markAt.left + markAt.width / 2, y: markAt.top + markAt.height / 2 };

const captions = {
  list: {
    element: $("#caption-list"),
    from: T.list.enter + 0.55,
    to: T.list.states - 0.1,
    title: "Every worktree,\nin one place.",
    sub: "On this computer and over <b>SSH</b>.",
  },
  states: {
    element: $("#caption-states"),
    from: T.list.states + 0.05,
    to: T.review.click - 0.1,
    title: "Find finished work.",
    sub: 'Unfinished work is <span class="care">left alone</span>.',
  },
  review: {
    element: $("#caption-review"),
    from: T.review.click + 0.2,
    to: T.review.click2 - 0.05,
    // No more than a headline here: the application says the rest itself,
    // and what it says is what is to be read.
    title: "Review before you delete.",
    sub: "",
  },
  delete: {
    element: $("#caption-delete"),
    from: T.delete.start + 0.45,
    to: T.end.start - 0.1,
    title: "Then it’s gone.",
    sub: "<b>Branches and commits kept.</b>",
  },
};
for (const caption of Object.values(captions)) {
  caption.words = words(caption.element.querySelector("h2"), caption.title);
  caption.element.querySelector(".sub").innerHTML = caption.sub;
}

// The opening the application is seen through. It stands beside the words
// for most of the film, and for the close look at the review it takes the
// width of the stage under a line of them.
const SIDE = { x: 664, y: 76, w: 1200, h: 929 },
  WIDE = { x: 190, y: 262, w: 1540, h: 782 };
const FIT = SIDE.w / 1240;
// After the second press the picture holds a moment, for the pointer to go,
// before anything moves.
const AFTER = T.review.click2 + 0.18;
function card(t) {
  const k = span(t, T.review.click, T.review.click + 0.7, ease.inOut5) - span(t, AFTER, AFTER + 0.66, ease.inOut5);
  return { x: lerp(SIDE.x, WIDE.x, k), y: lerp(SIDE.y, WIDE.y, k), w: lerp(SIDE.w, WIDE.w, k), h: lerp(SIDE.h, WIDE.h, k) };
}

function plan() {
  const rows = ["billing-webhooks", "graphql-pagination", "oauth-login", "rate-limit-headers", "release-2026-10", "upgrade-deps"].map((name) => place(rowNamed(name)));
  const care = place(rowNamed("billing-webhooks")),
    safe = union(place(rowNamed("oauth-login")), place(rowNamed("rate-limit-headers")));
  shots = {
    rows: union(...rows),
    care: { x: care.x + 8, y: care.y + 3, w: 700, h: care.h - 6 },
    safe: { x: safe.x + 8, y: safe.y + 3, w: 700, h: safe.h - 6 },
    button: place(inApp("#cleanup-button")),
    // Until the review has opened and been measured, where it will be.
    dialog: { x: 340, y: 60, w: 560, h: 840, cx: 620, cy: 480 },
    confirm: { cx: 820, cy: 870 },
    reason: { x: 400, y: 250, w: 300, h: 17 },
  };
  for (const row of allInApp(".worktree-row")) pathOf.set(row.dataset.id, row.dataset.path);
}
// The camera: the window's own point (x, y) is put at the opening's middle,
// enlarged s times, and never past the window's own edge.
function camera(t, frame) {
  const d = shots.dialog;
  const whole = [620, 480, FIT];
  const rows = [shots.rows.x + 367, shots.rows.y + shots.rows.h / 2 - 10, 1.55];
  // Wide enough to hold the button that is about to be pressed and the
  // review that pressing it opens, so the review arrives whole.
  const press = [723, 0, 1.2];
  const reach = WIDE.h / 1.72 / 2;
  const reviewTop = [d.cx, d.y + reach - 14, 1.72],
    reviewEnd = [d.cx, d.y + d.h - reach + 14, 1.72];
  // The line that says how the deletion is going runs the width of the
  // list, so this is as close as the camera can come and still read its
  // count at the far end.
  const strip = [724, 0, 1.163],
    list = [724, 470, 1.163],
    listEnd = [724, 960, 1.163];
  const [x, y, s] = through(t, [
    [T.list.states, whole],
    [T.list.states + 0.75, rows, ease.inOut5],
    [T.review.pointer, rows],
    [T.review.pointer + 0.7, press, ease.inOut5],
    [T.review.click, press],
    [T.review.click + 0.7, reviewTop, ease.inOut5],
    [T.review.scroll[0], reviewTop],
    [T.review.scroll[1], reviewEnd, ease.inOut5],
    [AFTER, reviewEnd],
    [AFTER + 0.66, strip, ease.inOut5],
    [T.delete.done[1], strip],
    [T.delete.done[4], list, ease.inOut],
    [T.delete.toast - 0.2, list],
    [T.delete.toast + 0.5, listEnd, ease.inOut],
    [T.end.start, listEnd],
  ]);
  const halfW = frame.w / s / 2,
    halfH = frame.h / s / 2;
  return [clamp(x, halfW, Math.max(halfW, 1240 - halfW)), clamp(y, halfH, Math.max(halfH, 960 - halfH)), s];
}

// The pointer's way across the window, in the window's own coordinates. It
// rests where it pressed: the review closing under it does not move it.
function pointer(t) {
  const button = shots.button,
    confirm = shots.confirm;
  const rest = [shots.dialog.x + shots.dialog.w + 70, shots.dialog.y + 250];
  return through(t, [
    [T.review.pointer, [button.cx - 190, button.cy + 250]],
    [T.review.hover + 0.05, [button.cx + 6, button.cy + 5], ease.inOut5],
    [T.review.click + 0.3, [button.cx + 6, button.cy + 5]],
    [T.review.click + 1.1, rest, ease.inOut],
    [T.review.pointer2, rest],
    [T.review.hover2 + 0.05, [confirm.cx + 4, confirm.cy + 4], ease.inOut5],
    [T.review.click2 + 1, [confirm.cx + 4, confirm.cy + 4]],
  ]);
}

function draw(t) {
  // Backdrop: two lights that drift, and grain that shimmers like film.
  $("#light-a").style.transform = `translate(${-480 + Math.sin(t * 0.21) * 90}px, ${-660 + Math.cos(t * 0.17) * 60}px)`;
  $("#light-b").style.transform = `translate(${880 + Math.cos(t * 0.19 + 1) * 110}px, ${160 + Math.sin(t * 0.23) * 70}px)`;
  $("#grain").style.backgroundPosition = `${Math.floor(wobble(Math.round(t * 60), 11) * 256)}px ${Math.floor(wobble(Math.round(t * 60), 13) * 256)}px`;
  $("#dots").style.transform = `translateY(${-t * 3}px)`;

  // 1. The pile.
  const pileOn = t < T.pile.end + 0.05;
  $("#pile").style.display = pileOn ? "" : "none";
  if (pileOn) {
    const collapse = span(t, T.pile.collapse, T.pile.end, ease.in);
    for (const [i, seat] of chips.entries()) {
      const k = span(t, seat.at, seat.at + 0.5, ease.back);
      const shown = span(t, seat.at, seat.at + 0.18);
      const drift = (t - seat.at) * 5;
      // Drawn in to where the mark is about to stand.
      const pull = ease.in(clamp((t - T.pile.collapse - wobble(i, 5) * 0.03 - 0.04) / (T.pile.end - T.pile.collapse - 0.08)));
      const x = lerp(seat.x + wobble(i, 7) * drift, MARK.x - 199, pull),
        y = lerp(seat.y + (1 - k) * 30 - drift * 0.4, MARK.y - 40, pull);
      seat.chip.style.opacity = shown * (1 - pull ** 2);
      seat.chip.style.transform = `translate(${x}px, ${y}px) rotate(${seat.turn * (1 - pull)}deg) scale(${lerp(0.82, 1, k) * (1 - pull * 0.8)})`;
      seat.chip.style.filter = pull > 0 ? `blur(${pull * 6}px)` : "none";
    }
    arrive(lineA, t, T.pile.lineA);
    const swap = span(t, T.pile.swap - 0.22, T.pile.swap, ease.in);
    $("#pile-line-a").style.opacity = 1 - swap;
    $("#pile-line-a").style.transform = `translateY(${-swap * 26}px)`;
    arrive(lineB, t, T.pile.swap + 0.02);
    const shownChips = chips.filter((seat) => seat.at <= t);
    const bytes = chips.reduce((sum, seat) => sum + seat.row.bytes * span(t, seat.at, seat.at + 0.22), 0);
    $("#pile-count").innerHTML = `${shownChips.length} ${shownChips.length === 1 ? "worktree" : "worktrees"}<i>·</i>${(bytes / GB).toFixed(1)} GB`;
    $("#pile-count").style.opacity = span(t, 0.2, 0.6) * (1 - collapse);
    $("#pile-copy").style.opacity = 1 - collapse;
    $("#pile-copy").style.transform = `scale(${1 - collapse * 0.12})`;
    $("#pile-copy").style.filter = collapse > 0 ? `blur(${collapse * 12}px)` : "none";
    $("#pile-scrim").style.opacity = 1 - collapse;
  }

  // 2 and 6. The name, first as an arrival and last as a place to go.
  const opening = t < T.brand.end + 0.1,
    closing = t >= T.end.start - 0.1;
  const brand = $("#brand");
  brand.style.display = (opening && t >= T.brand.start - 0.05) || closing ? "" : "none";
  if (brand.style.display === "") {
    const start = closing ? T.end.start + 0.22 : T.brand.start;
    const out = closing ? 0 : span(t, T.brand.out, T.brand.end, ease.in);
    brand.style.opacity = 1 - out;
    brand.style.transform = `scale(${1 - out * 0.08})`;
    brand.style.filter = out > 0 ? `blur(${out * 14}px)` : "none";
    $("#brand-row").style.top = `${closing ? 238 : 372}px`;
    $("#brand-row").style.transform = `scale(${closing ? 0.86 : 1})`;
    const tile = span(t, start, start + 0.55, ease.spring);
    $("#mark").style.transform = `scale(${lerp(0.5, 1, tile)}) rotate(${(1 - span(t, start, start + 0.5, ease.out5)) * -14}deg)`;
    $("#mark").style.opacity = span(t, start, start + 0.12);
    const trunk = span(t, start + 0.08, start + 0.4, ease.inOut);
    $("#mark-trunk").style.strokeDasharray = "1";
    $("#mark-trunk").style.strokeDashoffset = 1 - trunk;
    $("#mark-trunk").style.opacity = trunk > 0 ? 1 : 0;
    leaves.forEach((leaf, i) => {
      const k = span(t, start + 0.2 + i * 0.07, start + 0.6 + i * 0.07, ease.back);
      leaf.style.transform = `scale(${k})`;
      leaf.style.opacity = k > 0 ? 1 : 0;
    });
    // The name comes as one word, out from behind the mark.
    const name = span(t, start + 0.12, start + 0.62, ease.out5);
    $("#wordmark").style.opacity = name;
    $("#wordmark").style.transform = `translateX(${(1 - name) * -46}px)`;
    $("#wordmark").style.filter = name < 1 ? `blur(${(1 - name) * 12}px)` : "none";
    $("#alpha").style.opacity = closing ? span(t, start + 0.7, start + 1.1) : 0;
    $("#tagline").style.top = `${closing ? 498 : 648}px`;
    $("#tagline").textContent = closing ? "Clean up Git worktrees. Keep your branches." : "Git worktrees, under control.";
    const line = span(t, start + 0.38, start + 0.85, ease.out5);
    $("#tagline").style.opacity = line;
    $("#tagline").style.transform = `translateY(${(1 - line) * 22}px)`;
    $("#platforms").style.top = "596px";
    const platforms = closing ? span(t, start + 0.75, start + 1.25, ease.out5) : 0;
    $("#platforms").style.opacity = platforms;
    $("#platforms").style.transform = `translateY(${(1 - platforms) * 16}px)`;
    $("#address").style.top = "708px";
    const address = closing ? span(t, start + 1.0, start + 1.55, ease.out5) : 0;
    $("#address").style.opacity = address;
    $("#address").style.transform = `translate(-50%, ${(1 - address) * 16}px)`;
  }
  const hit = (at, strength) => (t >= at ? strength * (1 - span(t, at, at + 0.5, ease.out)) : 0);
  $("#flash").style.opacity = hit(T.brand.start, 0.5) + hit(T.end.start + 0.2, 0.3);
  // The light comes from the mark, wherever the mark is.
  const lit = t < 10 ? MARK : { x: 660, y: 320 };
  $("#flash").style.background = `radial-gradient(40% 40% at ${(lit.x / 1920) * 100}% ${(lit.y / 1080) * 100}%, #e9f7c6 0%, #9ccf7d55 40%, transparent 75%)`;

  // 3 to 5. The window, through its opening.
  const windowOn = t >= T.list.enter - 0.05 && t < T.end.start + 0.5;
  $("#card").style.visibility = windowOn ? "visible" : "hidden";
  if (windowOn) {
    const enter = span(t, T.list.enter, T.list.settle, ease.out5);
    const leave = span(t, T.end.start - 0.12, T.end.start + 0.42, ease.inOut);
    const frame = card(t);
    const [x, y, s] = camera(t, frame);
    $("#card").style.left = `${frame.x}px`;
    $("#card").style.top = `${frame.y}px`;
    $("#card").style.width = `${frame.w}px`;
    $("#card").style.height = `${frame.h}px`;
    $("#window").style.transform = `translate(${frame.w / 2 - s * x}px, ${frame.h / 2 - s * y}px) scale(${s})`;
    $("#card").style.opacity = span(t, T.list.enter, T.list.enter + 0.45) * (1 - leave);
    $("#card").style.transform = `translateY(${(1 - enter) * 280}px) rotateX(${(1 - enter) * 14}deg) scale(${lerp(0.9, 1, enter) * (1 - leave * 0.08)})`;
    $("#card").style.filter = leave > 0 ? `blur(${leave * 16}px)` : "none";
    $("#glow").style.opacity = enter * 0.6 * (1 - leave);

    // A place to look, while the words speak of it: the camera is still.
    const careOn = present(t, T.list.care, T.list.safe + 0.05, 0.3, 0.25),
      safeOn = present(t, T.list.safe, T.review.pointer + 0.15, 0.3, 0.3),
      whyOn = present(t, T.review.why, T.review.scroll[0] + 0.05, 0.3, 0.3);
    let target = safeOn > careOn ? shots.safe : shots.care;
    if (whyOn > 0) target = { x: shots.reason.x - 8, y: shots.reason.y - 4, w: shots.reason.w + 16, h: shots.reason.h + 8 };
    const on = Math.max(careOn, safeOn);
    $("#spot").style.opacity = on;
    $("#ring").style.opacity = Math.max(on, whyOn);
    for (const element of [$("#spot"), $("#ring")]) {
      element.style.transform = `translate(${target.x}px, ${target.y}px)`;
      element.style.width = `${target.w}px`;
      element.style.height = `${target.h}px`;
    }
    const green = safeOn > careOn || whyOn > 0;
    $("#ring").style.borderColor = green ? "#3f9a6c" : "#c98a2b";
    // The reason is marked as a line of text is, tinted and underlined, and
    // a whole row as a row is, outlined.
    $("#ring").style.background = whyOn > 0 ? "#3f9a6c1f" : "transparent";
    $("#ring").style.borderWidth = whyOn > 0 ? "0 0 2px 0" : "2px";
    $("#ring").style.borderRadius = whyOn > 0 ? "2px" : "8px";

    const [mx, my] = pointer(t);
    const pressed = (at) => (t >= at - 0.07 && t < at + 0.12 ? 0.86 : 1);
    // It leaves a moment after the second press, from where it pressed.
    $("#pointer").style.opacity = present(t, T.review.pointer, AFTER + 0.02, 0.3, 0.16);
    // The same size on the screen however far in the camera is.
    $("#pointer").style.transform = `translate(${mx}px, ${my}px) scale(${(1.7 / s) * pressed(T.review.click) * pressed(T.review.click2)})`;
    const ripple = [T.review.click, T.review.click2].map((at) => span(t, at, at + 0.3)).find((k) => k > 0 && k < 1) || 0;
    $("#ripple").style.opacity = ripple ? 1 - ripple : 0;
    $("#ripple").style.transform = `scale(${0.3 + ripple * 1.1})`;
  }

  // The words.
  for (const caption of Object.values(captions)) {
    const on = present(t, caption.from, caption.to, 0.4, 0.28);
    const leaving = span(t, caption.to - 0.28, caption.to, ease.in);
    caption.element.style.opacity = on;
    caption.element.style.transform = `translateY(${-leaving * 22}px)`;
    arrive(caption.words, t, caption.from + 0.08, { step: 0.06, rise: 30 });
    const kicker = span(t, caption.from, caption.from + 0.4, ease.out5);
    caption.element.querySelector(".kicker").style.opacity = kicker;
    const sub = span(t, caption.from + 0.4, caption.from + 0.95, ease.out5);
    caption.element.querySelector(".sub").style.opacity = sub;
    caption.element.querySelector(".sub").style.transform = `translateY(${(1 - sub) * 16}px)`;
  }
  const tallyFrom = T.delete.done[0] - 0.25;
  const tally = present(t, tallyFrom, T.end.start - 0.1, 0.4, 0.28);
  $("#tally").style.opacity = tally;
  $("#tally").style.transform = `translateY(${(1 - span(t, tallyFrom, tallyFrom + 0.5, ease.out5)) * 24 - span(t, T.end.start - 0.38, T.end.start - 0.1, ease.in) * 22}px)`;
  if (tally > 0) {
    $("#tally-number").textContent = (recovered(t) / GB).toFixed(1);
    const bump = T.delete.done.map((at) => (t >= at ? 1 - span(t, at, at + 0.3) : 0)).reduce((a, b) => Math.max(a, b), 0);
    $("#tally-figure").style.transform = `scale(${1 + bump * 0.035})`;
    $("#tally-figure").style.transformOrigin = "0 100%";
  }
  // While the review has the width of the stage there is no column for this.
  const wide = span(t, T.review.click - 0.2, T.review.click, ease.in) - span(t, T.review.click2 + 0.5, T.review.click2 + 0.9);
  $("#disclosure").style.opacity = present(t, T.list.settle, T.end.start - 0.1, 0.6, 0.3) * (1 - clamp(wide)) * 0.9;

  $("#fade").style.opacity = span(t, T.end.fade, T.duration - 0.05, ease.inOut) + (1 - span(t, 0, 0.35));
}

// ------------------------------------------------------------ the frames --

window.__ready = (async () => {
  await document.fonts.ready;
  await until(() => $("#app").contentDocument?.querySelectorAll("#worktree-list tr[data-id]").length === workspace.length, "the list of worktrees");
  await painted();
  plan();
})();

window.__seek = async (t, index = 0) => {
  while (nextCue < cues.length && cues[nextCue].at <= t) await cues[nextCue++].run();
  await applyDeletion(t);
  // Whatever turns in the application turns by the video's clock.
  for (const animation of $("#app").contentDocument.getAnimations()) {
    animation.pause();
    animation.currentTime = t * 1000;
  }
  draw(t);
  // Which frame this is, for the renderer to check its photograph against.
  $("#sync").style.background = `rgb(${((index >> 8) & 15) * 16 + 8}, ${((index >> 4) & 15) * 16 + 8}, ${(index & 15) * 16 + 8})`;
  await painted();
};
