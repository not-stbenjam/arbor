"use strict";

const path = require("node:path");

// Renderer requests identify a displayed worktree, never an arbitrary path.
function menuTarget(state, value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 4096 ||
    value.revision !== state.revision
  )
    throw new Error("The worktree list changed; try the menu again");
  const rows = state.report?.worktrees || state.partialWorktrees || [];
  const row = rows.find((entry) => entry.id === value.id);
  if (
    !row ||
    typeof row.path !== "string" ||
    !row.path ||
    row.path.length > 4096 ||
    row.path.includes("\0")
  )
    throw new Error("Worktree is no longer in the current list");
  const host = state.host || "";
  return {
    id: row.id,
    revision: state.revision,
    path: row.path,
    host,
    local: !host && path.isAbsolute(row.path) && !row.missing,
    removable:
      !state.busy &&
      !!state.revision &&
      !row.outsideRoot &&
      (row.canRemove === true || row.canDiscard === true),
    retryInspection:
      !state.busy && !!state.revision && row.retryInspection === true,
  };
}

function terminalCommand(platform, directory, findExecutable) {
  if (
    typeof directory !== "string" ||
    !path.isAbsolute(directory) ||
    directory.includes("\0")
  )
    throw new Error("A local absolute directory is required");
  if (platform === "darwin")
    return {
      binary: "/usr/bin/open",
      args: [
        "-a",
        "/System/Applications/Utilities/Terminal.app",
        "--",
        directory,
      ],
      cwd: directory,
    };
  if (platform !== "linux") return null;
  // Each directory is an argv value (or cwd), never terminal command text.
  const candidates = [
    ["ptyxis", ["--new-window", `--working-directory=${directory}`]],
    ["kgx", [`--working-directory=${directory}`]],
    ["gnome-terminal", [`--working-directory=${directory}`]],
    ["konsole", ["--workdir", directory]],
    ["xfce4-terminal", ["--working-directory", directory]],
    ["kitty", ["--directory", directory]],
    ["alacritty", ["--working-directory", directory]],
    ["foot", [`--working-directory=${directory}`]],
    ["wezterm", ["start", "--cwd", directory]],
    [
      "ghostty",
      [
        `--working-directory=${directory}`,
        "--window-inherit-working-directory=false",
      ],
    ],
    ["x-terminal-emulator", []],
    ["xterm", []],
  ];
  for (const [name, args] of candidates) {
    const binary = findExecutable(name);
    if (binary) return { binary, args, cwd: directory };
  }
  return null;
}

module.exports = { menuTarget, terminalCommand };
