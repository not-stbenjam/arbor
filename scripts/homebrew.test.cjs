"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { generate } = require("./homebrew.cjs");

const assets = [
  "darwin_arm64.tar.gz",
  "darwin_amd64.tar.gz",
  "linux_arm64.tar.gz",
  "linux_amd64.tar.gz",
  "darwin_arm64.app.zip",
  "darwin_amd64.app.zip",
];
const lines = assets.map(
  (asset, index) => `${String(index + 1).repeat(64)}  arbor_v0.2.0_${asset}`,
);

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-homebrew-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("maps all six release assets and hashes to portable recipes", (t) => {
  const dir = directory(t);
  generate("v0.2.0", lines.join("\r\n") + "\r\n", dir);
  const formula = fs.readFileSync(path.join(dir, "Formula/arbor.rb"), "utf8");
  const cask = fs.readFileSync(path.join(dir, "Casks/arbor.rb"), "utf8");
  for (let i = 0; i < 4; i++) {
    assert.ok(
      formula.includes(
        `arbor_v0.2.0_${assets[i]}"\n      sha256 "${String(i + 1).repeat(64)}"`,
      ),
    );
  }
  assert.match(
    formula,
    /on_macos do[\s\S]*on_arm do[\s\S]*on_intel do[\s\S]*on_linux do/,
  );
  assert.match(
    formula,
    /generate_completions_from_executable\(bin\/"arbor", "completion"\)/,
  );
  assert.match(
    formula,
    /system bin\/"arbor", "list", "--path", testpath\/"empty", "--json"/,
  );
  assert.match(
    cask,
    new RegExp(
      `sha256 arm:   "${"5".repeat(64)}",\\n         intel: "${"6".repeat(64)}"`,
    ),
  );
  assert.ok(
    cask.includes(
      "releases/download/v#{version}/arbor_v#{version}_darwin_#{arch}.app.zip",
    ),
  );
  assert.match(cask, /depends_on macos: :ventura/);
  assert.match(cask, /strategy :github_latest/);
  generate("0.2.0", lines.join("\n"), dir);
  assert.equal(
    fs.readFileSync(path.join(dir, "Formula/arbor.rb"), "utf8"),
    formula,
  );
  assert.equal(fs.readFileSync(path.join(dir, "Casks/arbor.rb"), "utf8"), cask);
});

for (const [index, asset] of assets.entries()) {
  test(`missing ${asset} fails before replacing recipes`, (t) => {
    const dir = directory(t);
    generate("0.2.0", lines.join("\n"), dir);
    const before = fs.readFileSync(path.join(dir, "Formula/arbor.rb"), "utf8");
    assert.throws(
      () =>
        generate("0.2.0", lines.filter((_, i) => i !== index).join("\n"), dir),
      { message: `Missing checksum for arbor_v0.2.0_${asset}` },
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "Formula/arbor.rb"), "utf8"),
      before,
    );
  });
}

test("rejects unsafe versions, malformed hashes and ambiguous manifests", (t) => {
  const dir = directory(t);
  for (const version of ["", "../0.2.0", '0.2.0"\n', "latest"]) {
    assert.throws(
      () => generate(version, lines.join("\n"), dir),
      /VERSION must/,
    );
  }
  assert.throws(
    () => generate("0.2.0", "bad  file", dir),
    /Invalid checksum line/,
  );
  assert.throws(
    () => generate("0.2.0", [...lines, lines[0]].join("\n"), dir),
    /Duplicate checksum/,
  );
  assert.equal(fs.existsSync(path.join(dir, "Formula")), false);
});

test("CLI reports usage and missing inputs with a nonzero exit", (t) => {
  const dir = directory(t);
  for (const [args, message] of [
    [[], /Usage: node scripts\/homebrew.cjs/],
    [["v0.2.0", path.join(dir, "missing"), dir], /ENOENT/],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "homebrew.cjs"), ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test("committed tap recipes match the published v0.2.0 checksums", (t) => {
  const dir = directory(t);
  const checksums = fs.readFileSync(
    path.join(__dirname, "testdata/arbor_v0.2.0_checksums.txt"),
    "utf8",
  );
  generate("v0.2.0", checksums, dir);
  for (const file of ["Formula/arbor.rb", "Casks/arbor.rb"]) {
    assert.equal(
      fs.readFileSync(
        path.join(__dirname, "../packaging/homebrew", file),
        "utf8",
      ),
      fs.readFileSync(path.join(dir, file), "utf8"),
      `Regenerate packaging/homebrew/${file} with the v0.2.0 test manifest`,
    );
  }
});
