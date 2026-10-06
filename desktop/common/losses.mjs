// What deleting a worktree that is not clean destroys. The command line
// names each loss a worktree holds; the words for them are the app's. A
// worktree with none is a clean delete, and one with any is never treated,
// described or confirmed as if it were.
export const LOSSES = {
  changes: {
    text: "uncommitted changes and untracked files",
    brief: "uncommitted changes",
  },
  ignored: {
    text: "ignored files",
    brief: "ignored files",
  },
  unchecked: {
    text: "changes to unchecked files",
    brief: "unchecked files",
  },
  // Grave: more than files in the folder. These are commits or a repository
  // that exist nowhere else, and agreeing to discard local files is not
  // agreeing to them. Each is shown by name and passed on by name.
  submodules: {
    text: "submodules and their unpushed commits",
    brief: "submodules",
    grave: true,
  },
  operation: {
    text: "unfinished rebase, merge or cherry-pick",
    brief: "unfinished Git operation",
    grave: true,
  },
  nested: {
    text: "nested repository, including history kept nowhere else",
    brief: "nested repository",
    grave: true,
  },
  // Refs under refs/worktree are one worktree's own. Git deletes them with
  // it, and nothing else may hold the commits they point to.
  refs: {
    text: "worktree refs (refs/worktree) and commits only they hold",
    brief: "refs of its own",
    grave: true,
  },
};

// The losses the last scan found in a row, in the order above. A row from a
// scan made before losses were named still says whether it had local files.
export function lossesOf(row) {
  const named = Array.isArray(row?.losses)
    ? row.losses
    : [row?.dirty && "changes", row?.ignored && "ignored"];
  // A folder that is missing or empty has no files in it to lose, whatever
  // an earlier look at it found. What Git keeps for it elsewhere remains.
  const gone = row?.missing || row?.empty;
  return Object.keys(LOSSES).filter(
    (name) => named.includes(name) && (!gone || LOSSES[name].grave),
  );
}

export const graveLosses = (row) =>
  lossesOf(row).filter((name) => LOSSES[name].grave);
