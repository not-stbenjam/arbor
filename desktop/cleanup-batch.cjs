"use strict";

const { randomUUID } = require("node:crypto");
const { removalArguments, removalFailure } = require("./removal-policy.cjs");

// Executes an already validated selection. It owns consent, one statistics
// session, CLI result validation and sequential finish-current behavior. It
// never reads application state or writes snapshots/cache; the backend owns
// that lifecycle and reconciles each verified outcome before the next item.
async function executeCleanupBatch(
  plan,
  { host, run, confirm, shouldStop, onBegin, onProgress, reconcile },
) {
  const { selected, discardLocal, recommendedOnly, confirmation } = plan;
  const results = [];
  if (
    confirmation.length &&
    (!confirm || !(await confirm(confirmation, { discardLocal })))
  )
    return { cancelled: true, results };
  const statsSession = randomUUID();
  onBegin();
  for (const row of selected) {
    if (shouldStop()) break;
    onProgress({ path: row.path, completed: results.length });
    let outcome;
    try {
      const args = removalArguments(row, {
        host,
        statsSession,
        discardLocal,
        recommendedOnly,
      });
      const result = JSON.parse(await run(args));
      if (!result || result.path !== row.path || result.removed !== true)
        throw new Error(
          (result?.path === row.path && result.error) ||
            "Arbor did not confirm removal",
        );
      outcome = {
        path: row.path,
        removed: true,
        ...(typeof result.retainedBranch === "string" && result.retainedBranch
          ? { retainedBranch: result.retainedBranch }
          : {}),
      };
    } catch (error) {
      outcome = {
        path: row.path,
        removed: false,
        error: removalFailure(error, row.path),
      };
    }
    const details = await reconcile(row, outcome);
    results.push({ ...outcome, ...details });
    onProgress({ path: row.path, completed: results.length });
  }
  return { results, stopped: shouldStop() };
}

module.exports = { executeCleanupBatch };
