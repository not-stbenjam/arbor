"use strict";

// Native window policy only. Backend owns cancellation, operation settlement,
// setup transitions, and whether starting another operation is permitted.
function createWindowLifecycle({
  app,
  dialog,
  getWindow,
  getBackend,
  getRemovalConfirmation,
}) {
  let waiting = false;
  let applicationQuitRequested = false;
  let cleanupPromptOpen = false;

  function finishWhenIdle(applicationQuit) {
    applicationQuitRequested ||= applicationQuit;
    if (waiting) return;
    waiting = true;
    getBackend()
      .waitUntilIdle()
      .then(() => {
        waiting = false;
        if (applicationQuitRequested) app.quit();
        else {
          const window = getWindow();
          if (window && !window.isDestroyed()) window.close();
        }
      });
  }

  function finishCleanup() {
    getBackend().requestClose({ finishCleanup: true });
    getRemovalConfirmation()?.abort();
    finishWhenIdle(true);
  }

  function guardClose(event, applicationQuit = false) {
    const backend = getBackend();
    if (!backend) return;
    const { action } = backend.requestClose();
    if (action === "close") return;
    event.preventDefault();
    if (action === "wait") {
      finishWhenIdle(applicationQuit);
      return;
    }
    // A still-open removal confirmation has not authorized any new deletion.
    // Closing it cancels that consent and lets the backend settle normally.
    if (getRemovalConfirmation()) {
      finishCleanup();
      return;
    }
    if (cleanupPromptOpen || waiting) return;
    cleanupPromptOpen = true;
    dialog
      .showMessageBox(getWindow(), {
        type: "info",
        title: "Cleanup is running",
        message: "Finish the current worktree, then quit?",
        detail:
          "Arbor will finish the one worktree currently being removed, leave the remaining worktrees untouched, and quit without rescanning.",
        buttons: ["Keep Arbor Open", "Finish Current & Quit"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 1) finishCleanup();
      })
      .catch(() => {
        // Failure to display a quit prompt never grants permission to stop cleanup.
      })
      .finally(() => {
        cleanupPromptOpen = false;
      });
  }

  return Object.freeze({ guardClose });
}

module.exports = { createWindowLifecycle };
