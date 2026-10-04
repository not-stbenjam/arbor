package worktree

import (
	"crypto/sha256"
	"fmt"
)

// Recommendations remain conservative. Explicit removal can discard local files
// in a verified linked checkout, after the user has confirmed the exact paths.
func annotateDiscard(w *Worktree) {
	w.CanDiscard = false
	w.DiscardWarnings = nil
	if w.Main || w.Bare || w.OutsideRoot || w.Missing || len(w.Problems) > 0 {
		return
	}
	for _, blocker := range w.Blockers {
		switch blocker {
		case "Uncommitted or untracked files":
			w.DiscardWarnings = append(w.DiscardWarnings, "Uncommitted changes and untracked files will be deleted.")
		case "Ignored files on disk (may include local secrets or build output)":
			w.DiscardWarnings = append(w.DiscardWarnings, "Ignored files will be deleted, including any local configuration or build output.")
		case "Locked worktree":
			w.DiscardWarnings = append(w.DiscardWarnings, "The Git worktree lock will be overridden.")
		case "Detached HEAD; create a branch to retain its commits":
			w.DiscardWarnings = append(w.DiscardWarnings, "The detached commit will be kept on a recovery branch.")
		case "Default branch", "Protected branch name":
			// A linked checkout of a named branch is removable; the branch stays.
		default:
			w.DiscardWarnings = nil
			return
		}
	}
	w.CanDiscard = true
}

// RecoveryBranch names a branch without incorporating path text or user input.
// Include the commit so repeated detached checkouts cannot overwrite old work.
func RecoveryBranch(w Worktree) string {
	sum := sha256.Sum256([]byte(w.CommonDir + "\x00" + w.Path + "\x00" + w.Head))
	return fmt.Sprintf("arbor/retained/%x", sum[:12])
}
