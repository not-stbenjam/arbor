"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

function registerSmokeTest({
  app,
  env = process.env,
  argv = process.argv,
  tmpdir = os.tmpdir,
}) {
  // Smoke tests must never inherit the user's preferences, cached scans, session
  // files, or CLI statistics, even when invoked without a dedicated test harness.
  // Keep this before app readiness and all app profile reads. Retain the private
  // profile for diagnosis; never delete or migrate the user's normal profile.
  if (env.ARBOR_SMOKE_TEST === "1") {
    const profile = fs.mkdtempSync(path.join(tmpdir(), "arbor-smoke-profile-"));
    const session = path.join(profile, "session");
    fs.mkdirSync(session, { mode: 0o700 });
    app.setPath("userData", profile);
    app.setPath("sessionData", session);
    env.ARBOR_STATS_PATH = path.join(profile, "statistics.json");
  }

  // Exercise the installed renderer, preload, IPC, and CLI together under Xvfb.
  // The opt-in smoke mode always requires an explicit, isolated scan folder.
  if (env.ARBOR_SMOKE_TEST === "1") {
    const root = env.ARBOR_SMOKE_ROOT;
    if (!root) {
      console.error("ARBOR_SMOKE_ROOT is required");
      app.exit(1);
    } else argv.push("--path", root);
    app.on("browser-window-created", (_event, win) => {
      const consoleErrors = [];
      win.webContents.on("console-message", (...args) => {
        const details = args.find(
          (value) => value && typeof value === "object" && "message" in value,
        );
        const level = details?.level ?? args[1],
          message = details?.message ?? args[2];
        if (level === 3 || level === "error")
          consoleErrors.push(String(message));
      });
      win.webContents.once("did-fail-load", (_event, code, description) => {
        console.error(`Arbor renderer failed to load: ${code} ${description}`);
        app.exit(1);
      });
      win.webContents.once("did-finish-load", async () => {
        try {
          const deadline = Date.now() + 25000;
          let state;
          do {
            state = await win.webContents.executeJavaScript(
              "window.arbor.getState()",
            );
            if (!state.busy && state.report) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } while (Date.now() < deadline);
          if (
            state.busy ||
            state.error ||
            !state.report ||
            !Array.isArray(state.report.worktrees)
          )
            throw new Error(state.error || "Smoke scan did not complete");
          if (env.ARBOR_SMOKE_CLEANUP === "1") {
            const canonical = fs.realpathSync(root),
              temporaryRoot = fs.realpathSync(tmpdir());
            const relative = path.relative(temporaryRoot, canonical);
            if (
              !relative ||
              relative.startsWith("..") ||
              path.isAbsolute(relative) ||
              !fs.existsSync(path.join(canonical, ".arbor-smoke-fixture"))
            )
              throw new Error(
                "Cleanup smoke requires a marked, disposable fixture beneath the temporary directory",
              );
            const candidates = state.report.worktrees.filter(
              (w) => w.recommended,
            );
            if (!candidates.length)
              throw new Error("Cleanup smoke fixture has no recommendations");
            for (const candidate of candidates) {
              const selected = path.relative(canonical, candidate.path);
              if (
                !selected ||
                selected.startsWith("..") ||
                path.isAbsolute(selected)
              )
                throw new Error(
                  "Cleanup smoke candidate is outside the disposable fixture",
                );
            }
            const originalScan = {
              scannedAt: state.report.scannedAt,
              durationMs: state.report.durationMs,
              root: state.report.root,
            };
            const expectedSurvivors = state.report.worktrees
              .filter(
                (row) =>
                  !candidates.some((candidate) => candidate.path === row.path),
              )
              .map((row) => row.path)
              .sort();
            const beforeStats = await win.webContents.executeJavaScript(
              "window.arbor.getStats()",
            );
            const before = state.report.worktrees.length;
            const selection = {
              items: candidates.map((w) => ({ id: w.id, head: w.head })),
              revision: state.revision,
              recommendedOnly: true,
            };
            const removed = await win.webContents.executeJavaScript(
              `window.arbor.remove(${JSON.stringify(selection)})`,
            );
            if (
              removed.results?.length !== candidates.length ||
              removed.results.some((result) => !result.removed)
            )
              throw new Error(
                "Cleanup smoke could not remove every recommendation",
              );
            state = await win.webContents.executeJavaScript(
              "window.arbor.getState()",
            );
            if (
              state.error ||
              state.busy ||
              state.report.worktrees.length !== before - candidates.length
            )
              throw new Error(
                "Cleanup smoke did not update the worktree report",
              );
            for (const [key, value] of Object.entries(originalScan))
              if (state.report[key] !== value)
                throw new Error(
                  `Cleanup smoke unexpectedly rescanned (${key} changed)`,
                );
            const survivors = state.report.worktrees
              .map((row) => row.path)
              .sort();
            if (JSON.stringify(survivors) !== JSON.stringify(expectedSurvivors))
              throw new Error("Cleanup smoke changed unselected worktree rows");
            const afterStats = await win.webContents.executeJavaScript(
              "window.arbor.getStats()",
            );
            if (
              afterStats.report.removedWorktrees -
                beforeStats.report.removedWorktrees !==
              candidates.length
            )
              throw new Error(
                "Cleanup smoke statistics did not count every removed worktree",
              );
            if (
              afterStats.report.cleanupSessions -
                beforeStats.report.cleanupSessions !==
              1
            )
              throw new Error(
                "Cleanup smoke statistics did not record exactly one bulk session",
              );
            console.log(
              `Arbor cleanup smoke passed: removed ${candidates.length} fixture worktrees through Electron IPC`,
            );
          }
          // The idle status line counts repositories, in either number.
          const settled = /\brepositor(?:y|ies)\b/;
          let rendered;
          for (let attempt = 0; attempt < 50; attempt++) {
            rendered = await win.webContents.executeJavaScript(
              `({ text: document.body.innerText, rows: document.querySelectorAll('#worktree-list tr[data-id]').length, count: document.querySelector('#all-count')?.textContent, status: document.querySelector('#status-message')?.textContent, error: document.querySelector('#error-banner')?.hidden === false })`,
            );
            if (
              Number(rendered.count) === state.report.worktrees.length &&
              rendered.rows === state.report.worktrees.length &&
              settled.test(rendered.status)
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (
            rendered.text.trim().length < 20 ||
            Number(rendered.count) !== state.report.worktrees.length ||
            rendered.rows !== state.report.worktrees.length ||
            !settled.test(rendered.status)
          )
            throw new Error("Renderer did not display the completed scan");
          if (rendered.error || consoleErrors.length)
            throw new Error(
              `Renderer reported an error: ${consoleErrors.join("; ") || "error banner visible"}`,
            );
          if (env.ARBOR_SMOKE_SCREENSHOT) {
            win.setContentSize(1240, 800);
            await new Promise((resolve) => setTimeout(resolve, 300));
            const image = await win.webContents.capturePage();
            await fsp.writeFile(env.ARBOR_SMOKE_SCREENSHOT, image.toPNG());
          }
          console.log(
            `Arbor Electron smoke passed: ${state.report.worktrees.length} worktrees; preload, IPC, CLI, and renderer ready`,
          );
          app.exit(0);
        } catch (error) {
          console.error("Arbor Electron smoke failed:", error);
          app.exit(1);
        }
      });
    });
  }
}

module.exports = { registerSmokeTest };
