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

function usesDiscardLocal(row, discardLocal) {
  return discardLocal === true && !row.canRemove;
}

function removalConfirmationOptions(trees, discardLocal) {
  const shorten = (value, limit) => {
    const characters = Array.from(
      String(value || "").replace(
        /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
        " ",
      ),
    );
    if (characters.length <= limit) return characters.join("");
    const start = Math.floor((limit - 1) / 2);
    return (
      characters.slice(0, start).join("") +
      "…" +
      characters.slice(-(limit - start - 1)).join("")
    );
  };
  const existing = trees.filter((row) => !row.missing);
  const missing = trees.length - existing.length;
  const registrationsOnly = missing > 0 && !existing.length;
  // Consent follows the operation, not potentially stale scan metadata.
  const discardsFiles = existing.some(
    (row) => !row.empty && usesDiscardLocal(row, discardLocal),
  );
  const notes = [
    registrationsOnly
      ? "Only Git worktree registrations will be removed; their folders are already missing. Git branches and commits are retained."
      : "The selected worktree folders will be deleted. Git branches and commits are retained.",
  ];
  if (missing && !registrationsOnly)
    notes.push(
      `${missing} missing worktree ${missing === 1 ? "registration will" : "registrations will"} also be removed; no folders exist at those paths.`,
    );
  if (discardsFiles)
    notes.push(
      "Any local files, including uncommitted, untracked, and ignored files, will be permanently discarded.",
    );
  if (trees.some((row) => row.locked && usesDiscardLocal(row, discardLocal)))
    notes.push(
      "Git worktree locks on the selected entries will be overridden.",
    );
  if (existing.some((row) => row.detached))
    notes.push(
      "Detached commits will be retained; recovery branches are created only if needed.",
    );
  const preview = trees.slice(0, 5).map((row) => shorten(row.path, 120));
  if (trees.length > preview.length)
    preview.push(
      `and ${trees.length - preview.length} more selected ${trees.length - preview.length === 1 ? "worktree" : "worktrees"}`,
    );
  const name = shorten(
    path.basename(trees[0]?.path || "") || trees[0]?.branch || "worktree",
    80,
  );
  return {
    title: registrationsOnly
      ? `Remove missing worktree registration${trees.length === 1 ? "" : "s"}?`
      : discardsFiles
        ? "Discard local data and remove?"
        : "Remove worktree?",
    message:
      trees.length === 1
        ? `Remove ${registrationsOnly ? "registration for " : ""}“${name}”?`
        : `Remove ${trees.length} ${registrationsOnly ? "missing worktree registrations" : "worktrees"}?`,
    detail: `${notes.join("\n")}\n\n${preview.join("\n")}`,
    buttons: [
      "Cancel",
      registrationsOnly
        ? "Remove Registration" + (trees.length > 1 ? "s" : "")
        : discardsFiles
          ? "Discard & Remove"
          : "Remove Worktree" + (trees.length > 1 ? "s" : ""),
    ],
  };
}

module.exports = {
  menuTarget,
  terminalCommand,
  removalConfirmationOptions,
  usesDiscardLocal,
};
