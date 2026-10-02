#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const manifest = require("../package.json");

const root = path.resolve(__dirname, "..");
process.chdir(root);
// Keep local and CI archive builds quick; callers can explicitly choose a level.
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ||= "6";
const version = process.env.ARBOR_VERSION || `v${manifest.version}`;
if (
  !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)
) {
  throw new Error(
    "ARBOR_VERSION must be a semantic version, for example v0.1.0",
  );
}
const tag = version.startsWith("v") ? version : `v${version}`;
const appVersion = version.replace(/^v/, "");
const goArch = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!goArch || !["darwin", "linux"].includes(process.platform)) {
  throw new Error("Build Arbor on macOS or Linux, on ARM64 or x86-64.");
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with status ${result.status}`);
}

fs.mkdirSync(path.join(root, "bin"), { recursive: true });
fs.mkdirSync(path.join(root, "build", "icons"), { recursive: true });
run(
  process.env.GO || "go",
  [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X main.version=${tag}`,
    "-o",
    "bin/arbor-cli",
    "./cmd/arbor",
  ],
  { CGO_ENABLED: "0", GOOS: process.platform, GOARCH: goArch },
);
run(process.env.GO || "go", ["run", "./scripts/icon", "build/icons"]);

if (!process.argv.includes("--prepare")) {
  // Electron 44 downloads its runtime lazily when this module is first loaded.
  // Resolve it before giving electron-builder the pinned local distribution.
  require("electron");
  const { build, Platform, Arch } = require("electron-builder");
  const platform =
    process.platform === "darwin" ? Platform.MAC : Platform.LINUX;
  const architecture = process.arch === "arm64" ? Arch.arm64 : Arch.x64;
  const targets = process.argv.includes("--dir")
    ? ["dir"]
    : process.platform === "darwin"
      ? ["dir"]
      : ["AppImage", "tar.gz"];

  build({
    targets: platform.createTarget(targets, architecture),
    publish: "never",
    config: {
      appId: "io.github.not-stbenjam.arbor",
      productName: "Arbor",
      executableName: "arbor-desktop",
      electronDist: path.join(root, "node_modules/electron/dist"),
      directories: { output: "dist", buildResources: "build/icons" },
      files: [
        "desktop/**/*.cjs",
        "desktop/renderer/**/*",
        "desktop/common/**/*",
        "package.json",
        "!desktop/**/*.test.cjs",
        "!desktop/smoke-test.cjs",
      ],
      extraResources: [
        { from: "bin/arbor-cli", to: "bin/arbor-cli" },
        { from: "build/icons/icon.png", to: "icon.png" },
      ],
      extraMetadata: { version: appVersion },
      asar: true,
      npmRebuild: false,
      mac: {
        executableName: "Arbor",
        icon: "build/icons/Arbor.icns",
        category: "public.app-category.developer-tools",
        minimumSystemVersion: "13.0",
        identity: "-",
        artifactName: `arbor_${tag}_darwin_${goArch}.app.\${ext}`,
      },
      linux: {
        icon: "build/icons/icon.png",
        syncDesktopName: true,
        category: "Development",
        synopsis: "Manage Git worktrees",
        artifactName: `arbor_${tag}_linux_${goArch}.desktop.\${ext}`,
      },
      appImage: {
        artifactName: `arbor_${tag}_linux_${goArch}.\${ext}`,
      },
    },
  })
    .then(() => {
      if (process.platform !== "darwin" || process.argv.includes("--dir"))
        return;
      // Use Apple's archive writer for Finder/Archive Utility compatibility and
      // preservation of signed framework symlinks and macOS bundle metadata.
      const app = path.join(
        root,
        "dist",
        process.arch === "arm64" ? "mac-arm64" : "mac",
        "Arbor.app",
      );
      const destination = path.join(
        root,
        "dist",
        `arbor_${tag}_darwin_${goArch}.app.zip`,
      );
      const staging = fs.mkdtempSync(path.join(root, "dist", ".mac-archive-"));
      const archive = path.join(staging, "Arbor.app.zip");
      try {
        run("/usr/bin/ditto", [
          "-c",
          "-k",
          "--sequesterRsrc",
          "--keepParent",
          app,
          archive,
        ]);
        fs.renameSync(archive, destination);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
