"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { childEnvironment } = require("./process-runner.cjs");
const { menuTarget, terminalCommand } = require("./worktree-menu.cjs");

async function localDirectory(target) {
  if (!target.local || target.host)
    throw new Error("This action is only available for local worktrees");
  const info = await fsp.stat(target.path);
  if (!info.isDirectory())
    throw new Error("The worktree directory no longer exists");
}

function findExecutable(name) {
  for (const directory of (childEnvironment().PATH || "").split(
    path.delimiter,
  )) {
    if (!path.isAbsolute(directory)) continue;
    const binary = path.join(directory, name);
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      if (fs.statSync(binary).isFile()) return binary;
    } catch {
      /* Try the next PATH directory. */
    }
  }
  return null;
}

function launchTerminal(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      cwd: command.cwd,
      env: childEnvironment(),
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function createWorktreeContextMenu({
  backend,
  getWindow,
  Menu,
  dialog,
  shell,
  clipboard,
  sendAction,
  platform = process.platform,
}) {
  const guardInteraction = () => backend.assertInteractive();
  function show(value) {
    const window = getWindow();
    guardInteraction();
    const target = menuTarget(backend.getState(), value);
    const current = () => {
      guardInteraction();
      const next = menuTarget(backend.getState(), value);
      if (next.path !== target.path || next.host !== target.host)
        throw new Error("The worktree list changed; try the menu again");
      return next;
    };
    const click = (action) => () => {
      Promise.resolve()
        .then(() => action(current()))
        .catch((error) => {
          if (window && !window.isDestroyed())
            void dialog.showMessageBox(window, {
              type: "error",
              title: "Worktree action unavailable",
              message: error.message,
            });
        });
    };
    const localLabel = target.host ? " (local worktrees only)" : "";
    const terminal = target.local
      ? terminalCommand(platform, target.path, findExecutable)
      : null;
    Menu.buildFromTemplate([
      {
        label: "Copy Path",
        click: click((row) => clipboard.writeText(row.path)),
      },
      { type: "separator" },
      {
        label:
          (platform === "darwin"
            ? "Reveal in Finder"
            : "Show in File Manager") + localLabel,
        enabled: target.local,
        click: click(async (row) => {
          await localDirectory(row);
          shell.showItemInFolder(row.path);
        }),
      },
      {
        label: "Open Folder" + localLabel,
        enabled: target.local,
        click: click(async (row) => {
          await localDirectory(row);
          const error = await shell.openPath(row.path);
          if (error) throw new Error(error);
        }),
      },
      {
        label:
          "Open in Terminal" +
          localLabel +
          (target.local && !terminal ? " (not installed)" : ""),
        enabled: !!terminal,
        click: click(async (row) => {
          await localDirectory(row);
          const command = terminalCommand(platform, row.path, findExecutable);
          if (!command) throw new Error("No supported terminal is installed");
          await launchTerminal(command);
        }),
      },
      { type: "separator" },
      ...(target.retryInspection
        ? [
            {
              label: "Retry Inspection",
              click: click((row) =>
                backend.inspectWorktree({ id: row.id, revision: row.revision }),
              ),
            },
          ]
        : []),
      {
        label: "Delete Worktree…",
        enabled: target.removable,
        click: click((row) => {
          if (!row.removable)
            throw new Error("The worktree is no longer available for deletion");
          sendAction({
            type: "worktree-remove",
            id: row.id,
            revision: row.revision,
          });
        }),
      },
    ]).popup({ window });
    return true;
  }
  return show;
}

module.exports = { createWorktreeContextMenu };
