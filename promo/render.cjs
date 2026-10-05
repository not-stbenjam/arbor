"use strict";

// Draws the promotional video one frame at a time. The composition is a web
// page that can show itself at any moment of its timeline; this asks for each
// moment in turn, photographs the window, and hands the pictures to ffmpeg.
// Nothing runs in real time, so a slow machine draws the same video as a fast
// one.
//
//   electron promo/render.cjs --stills 0,2.5,7 --out DIR      pictures to look at
//   electron promo/render.cjs --video FILE [--from S --to S]  the video, silent
//
// Options: --fps 60, --samples N (pictures blended into each frame, which
// blurs whatever moves), --scale N (draw larger and reduce, for finer edges),
// --onscreen (photograph a real window instead of drawing off screen, which
// is slower and gives the same picture).

const { app, BrowserWindow, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const WIDTH = 1920,
  HEIGHT = 1080,
  // A strip under the picture carries the number of the frame it shows, so a
  // photograph taken before the window had redrawn is noticed and retaken.
  STRIP = 4;
const fps = Number(argument("fps", 60)),
  samples = Number(argument("samples", 1)),
  scale = Number(argument("scale", 1)),
  stills = argument("stills", ""),
  video = argument("video", ""),
  out = argument("out", "."),
  from = Number(argument("from", 0)),
  to = Number(argument("to", 30)),
  ffmpeg = argument("ffmpeg", process.env.FFMPEG || "ffmpeg"),
  offscreen = !process.argv.includes("--onscreen");

app.commandLine.appendSwitch("force-device-scale-factor", String(scale));
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("force-color-profile", "srgb");
if (offscreen) app.disableHardwareAcceleration();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT + STRIP,
    useContentSize: true,
    frame: false,
    // Drawn off screen, there is no window to show.
    show: !offscreen,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "mock-preload.cjs"),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      backgroundThrottling: false,
      webSecurity: false,
      offscreen,
    },
  });
  const page = window.webContents;
  // Drawn off screen, the window hands over each picture as it paints it.
  let painted = null,
    waiting = [];
  if (offscreen) {
    page.setFrameRate(60);
    page.on("paint", (_event, _dirty, image) => {
      // The picture is only lent for the length of this call, so it is copied.
      const { width, height } = image.getSize();
      painted = { width, height, pixels: Buffer.from(image.getBitmap()), image };
      for (const resolve of waiting.splice(0)) resolve();
    });
  }
  // The next picture the window paints. Asking for one can be answered at
  // once with the picture it already had, so the caller looks at each that
  // comes until the one it is waiting for does.
  const nextPaint = () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      setTimeout(resolve, 250);
    });
  const problems = [];
  page.on("console-message", (_event, level, message) => {
    if (level >= 2) problems.push(message);
  });
  await page.loadFile(path.join(__dirname, "composition", "index.html"));
  const js = (source) => page.executeJavaScript(source);
  await js("window.__ready");

  let index = 0;
  // One picture of the composition at time `t`, as raw BGRA rows.
  async function picture(t) {
    index = (index + 1) % 4096 || 1;
    await js(`window.__seek(${t}, ${index})`);
    for (const deadline = Date.now() + 30000; Date.now() < deadline; ) {
      if (offscreen) await nextPaint();
      if (offscreen && !painted) continue;
      const image = offscreen ? painted.image : await page.capturePage();
      const { width, height } = offscreen ? painted : image.getSize();
      const pixels = offscreen ? painted.pixels : image.toBitmap();
      const row = pixels.length / height;
      const at = (height - Math.ceil((STRIP * height) / (HEIGHT + STRIP) / 2)) * row + 8 * 4;
      // The frame's number is in the strip's colour, four bits to a channel,
      // each in the middle of its step so a shade either way reads the same.
      const seen = ((pixels[at + 2] >> 4) << 8) | ((pixels[at + 1] >> 4) << 4) | (pixels[at] >> 4);
      if (seen === index)
        return { pixels: pixels.subarray(0, Math.round((HEIGHT * height) / (HEIGHT + STRIP)) * row), width, height: Math.round((HEIGHT * height) / (HEIGHT + STRIP)), image };
      if (!offscreen) await wait(8);
    }
    throw new Error(`the window never showed frame ${index} (t=${t})`);
  }

  try {
    if (stills) {
      fs.mkdirSync(out, { recursive: true });
      for (const value of stills.split(",")) {
        const t = Number(value);
        const { pixels, width, height } = await picture(t);
        const file = path.join(out, `still-${t.toFixed(2).padStart(5, "0")}.png`);
        fs.writeFileSync(file, nativeImage.createFromBitmap(Buffer.from(pixels), { width, height }).toPNG());
      }
    } else if (video) {
      const frames = Math.round((to - from) * fps);
      const first = await picture(from);
      const filters = [];
      if (samples > 1)
        filters.push(`tmix=frames=${samples}`, `select='eq(mod(n\\,${samples})\\,${samples - 1})'`, `setpts=N/${fps}/TB`);
      if (scale !== 1) filters.push(`scale=${WIDTH}:${HEIGHT}:flags=lanczos`);
      filters.push("format=yuv420p");
      const encoder = spawn(
        ffmpeg,
        [
          "-y", "-hide_banner", "-loglevel", "error",
          "-f", "rawvideo", "-pix_fmt", "bgra",
          "-s", `${first.width}x${first.height}`,
          "-r", String(fps * samples),
          "-i", "-",
          "-vf", filters.join(","),
          "-r", String(fps),
          "-c:v", "libx264", "-preset", "slow", "-crf", argument("crf", "14"),
          "-profile:v", "high", "-pix_fmt", "yuv420p",
          "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
          "-movflags", "+faststart",
          video,
        ],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      const closed = new Promise((resolve, reject) =>
        encoder.on("close", (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())),
      );
      const write = (pixels) =>
        new Promise((resolve) => (encoder.stdin.write(Buffer.from(pixels)) ? resolve() : encoder.stdin.once("drain", resolve)));
      const started = Date.now();
      for (let frame = 0; frame < frames; frame++) {
        for (let sample = 0; sample < samples; sample++) {
          // Samples cover the time the frame is on screen, ending at its own moment.
          const t = from + (frame + (sample + 1) / samples - 1) / fps;
          const shot = frame === 0 && sample === samples - 1 && samples === 1 ? first : await picture(Math.max(from, t));
          await write(shot.pixels);
        }
        if (frame % 120 === 0)
          console.log(`frame ${frame} of ${frames} · ${((Date.now() - started) / 1000).toFixed(0)}s`);
      }
      encoder.stdin.end();
      await closed;
    }
    if (problems.length) console.log("console:", [...new Set(problems)].slice(0, 8));
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (problems.length) console.log("console:", [...new Set(problems)].slice(0, 8));
    app.exit(1);
  }
});
