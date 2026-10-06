#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function generate(version, checksums, outDir) {
  if (
    !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)
  ) {
    throw new Error("VERSION must be a semantic version, for example v0.2.0");
  }
  const number = version.replace(/^v/, "");
  const tag = `v${number}`;
  const hashes = new Map();
  for (const line of checksums.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64})  (\S+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    if (hashes.has(match[2])) {
      throw new Error(`Duplicate checksum for ${match[2]}`);
    }
    hashes.set(match[2], match[1].toLowerCase());
  }
  function asset(os, arch, extension) {
    const name = `arbor_${tag}_${os}_${arch}.${extension}`;
    const sha256 = hashes.get(name);
    if (!sha256) throw new Error(`Missing checksum for ${name}`);
    return { name, sha256 };
  }
  const base = "https://github.com/stbenjam/arbor";
  const platforms = [
    ["macos", "darwin"],
    ["linux", "linux"],
  ].map(([brewOS, os]) => {
    const architectures = [
      ["arm", "arm64"],
      ["intel", "amd64"],
    ].map(([brewArch, arch]) => {
      const file = asset(os, arch, "tar.gz");
      return `    on_${brewArch} do
      url "${base}/releases/download/${tag}/${file.name}"
      sha256 "${file.sha256}"
    end`;
    });
    return `  on_${brewOS} do
${architectures.join("\n\n")}
  end`;
  });
  // Homebrew infers the formula version from the URLs; audit rejects a duplicate.
  const formula = `class Arbor < Formula
  desc "Manage Git worktrees"
  homepage "${base}"
  license "MIT"

${platforms.join("\n\n")}

  def install
    bin.install "arbor"
    generate_completions_from_executable(bin/"arbor", "completion")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/arbor version")
    (testpath/"empty").mkpath
    system bin/"arbor", "list", "--path", testpath/"empty", "--json"
  end
end
`;
  const arm = asset("darwin", "arm64", "app.zip");
  const intel = asset("darwin", "amd64", "app.zip");
  const cask = `cask "arbor" do
  arch arm: "arm64", intel: "amd64"

  version "${number}"
  sha256 arm:   "${arm.sha256}",
         intel: "${intel.sha256}"

  url "${base}/releases/download/v#{version}/arbor_v#{version}_darwin_#{arch}.app.zip"
  name "Arbor"
  desc "Manage Git worktrees"
  homepage "${base}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Arbor.app"

  zap trash: [
    "~/Library/Application Support/Arbor",
    "~/Library/Application Support/arbor/statistics.json",
    "~/Library/Preferences/io.github.stbenjam.arbor.plist",
    "~/Library/Saved Application State/io.github.stbenjam.arbor.savedState",
  ]

  caveats <<~EOS
    Arbor is ad-hoc signed, but not yet signed with an Apple Developer ID
    or notarized. macOS will refuse to open it the first time. After trying
    to open it, go to System Settings → Privacy & Security → Open Anyway.
    Only approve a download you trust.
  EOS
end
`;
  // Validate every required checksum before replacing either recipe.
  for (const [directory, contents] of [
    ["Formula", formula],
    ["Casks", cask],
  ]) {
    fs.mkdirSync(path.join(outDir, directory), { recursive: true });
    fs.writeFileSync(path.join(outDir, directory, "arbor.rb"), contents);
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) {
      throw new Error(
        "Usage: node scripts/homebrew.cjs VERSION CHECKSUMS_FILE OUT_DIR",
      );
    }
    generate(args[0], fs.readFileSync(args[1], "utf8"), args[2]);
  } catch (error) {
    console.error(`homebrew: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { generate };
