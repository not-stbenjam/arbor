package worktree

import (
	"crypto/sha256"
	"fmt"
	"slices"
	"strings"
)

// reasonCode is internal policy input, not user-facing copy or a wire format.
// Unknown codes fail closed; wording can change without changing eligibility.
type reasonCode uint8

const (
	reasonPrimary reasonCode = iota
	reasonBare
	reasonOutside
	reasonLocked
	reasonDetached
	reasonMissing
	reasonUnverifiedPath
	reasonNoCommit
	reasonEmpty
	reasonStatus
	reasonDirty
	reasonIgnored
	reasonIndex
	reasonSubmoduleInspection
	reasonUnchecked
	reasonSubmodules
	reasonMetadata
	reasonOperation
	reasonDefaultBranch
	reasonProtectedBranch
	reasonNested
	reasonFiles
	reasonPathText
	reasonPrivateRefs
	reasonFilterOff
	reasonCount
)

type reasonDescription struct {
	message string
	manual  bool
	warning string
	// loss names what deleting anyway destroys: a short stable name that the
	// app and the command line pass to each other, and the words that finish
	// "Deleting it permanently discards …". A reason that costs nothing, such
	// as a lock or a detached commit that is retained, has neither. A
	// worktree with any loss is not a clean delete, and is told apart from
	// one that is.
	loss, lossText string
	// grave marks a loss of more than files in the folder: commits or a
	// repository that exist nowhere else. Agreeing to discard local files is
	// not agreeing to these; each must have been shown and accepted by name.
	grave bool
}

var reasonDescriptions = [...]reasonDescription{
	reasonPrimary:             {message: "Primary worktree"},
	reasonBare:                {message: "Bare repository"},
	reasonOutside:             {message: "Outside the scan folder"},
	reasonLocked:              {message: "Locked worktree", manual: true, warning: "The Git worktree lock will be overridden."},
	reasonDetached:            {message: "Detached HEAD; create a branch to retain its commits", manual: true, warning: "The detached commit will be retained; a recovery branch is created only if needed."},
	reasonMissing:             {message: "Worktree directory is missing", manual: true, warning: "The folder is already gone. Only what Git still keeps for this worktree will be removed; its branches are retained."},
	reasonUnverifiedPath:      {message: "Worktree path could not be verified"},
	reasonNoCommit:            {message: "No commit to preserve"},
	reasonEmpty:               {message: "Empty checkout directory; only its stale registration remains", manual: true, warning: "Only the empty directory and its stale Git registration will be removed; branches and commits are retained."},
	reasonStatus:              {message: "Cannot read working directory status"},
	reasonDirty:               {message: "Uncommitted or untracked files", manual: true, warning: "Uncommitted changes and untracked files will be deleted.", loss: "changes", lossText: "uncommitted changes and untracked files"},
	reasonIgnored:             {message: "Ignored files on disk (may include local secrets or build output)", manual: true, warning: "Ignored files will be deleted, including any local configuration or build output.", loss: "ignored", lossText: "ignored files, such as local configuration or build output"},
	reasonIndex:               {message: "Cannot verify index flags"},
	reasonSubmoduleInspection: {message: "Cannot verify submodules"},
	reasonUnchecked:           {message: "Unchecked files: Git was told not to look at some files (assume-unchanged, skip-worktree, or inside a submodule that is not checked out)", manual: true, warning: "Files Git was told not to look at will be deleted; changes to them cannot be seen.", loss: "unchecked", lossText: "any changes to files Git was told not to look at"},
	reasonSubmodules:          {message: "Submodules: has submodule checkouts, which keep commits of their own", manual: true, warning: "Submodule checkouts will be deleted, along with any commits made inside them that were never pushed.", loss: "submodules", lossText: "submodule checkouts, and any commits made inside them that were never pushed", grave: true},
	reasonMetadata:            {message: "Cannot locate Git metadata"},
	reasonOperation:           {message: "Unfinished Git operation: a rebase, merge, cherry-pick, revert or bisect is in progress", manual: true, warning: "The unfinished rebase, merge or other Git operation will be abandoned.", loss: "operation", lossText: "the unfinished Git operation (a rebase, merge, cherry-pick, revert or bisect)", grave: true},
	reasonDefaultBranch:       {message: "Default branch", manual: true},
	reasonProtectedBranch:     {message: "Protected branch name", manual: true},
	reasonNested:              {message: "Nested repository: another Git repository or worktree is inside this folder", manual: true, warning: "The separate Git repository or worktree inside this folder will be deleted with it, including any history kept nowhere else.", loss: "nested", lossText: "the separate Git repository or worktree inside the folder, with any history kept nowhere else", grave: true},
	reasonFiles:               {message: "Cannot inspect every file"},
	// Arbor names a worktree by its path, as text. Bytes that are not text
	// cannot be written down and read back as the same path.
	reasonPathText: {message: "Path is not valid text (UTF-8), so Arbor cannot name it reliably; use git worktree remove"},
	// Refs under refs/worktree belong to one worktree and are deleted with
	// it. Nothing else may hold the commits they point to.
	reasonPrivateRefs: {message: "Refs of its own: refs/worktree refs are deleted with this worktree", manual: true, warning: "This worktree's own refs (refs/worktree) will be deleted, and nothing else may keep the commits they point to.", loss: "refs", lossText: "this worktree's own refs (refs/worktree), and any commits only they point to", grave: true},
	// With a filter program switched off, Git compares a file it would
	// rewrite as it lies, which can make a changed file look unchanged.
	reasonFilterOff: {message: "Unchecked files: its repository names a filter program Arbor does not run, so files it rewrites could not be checked for changes", manual: true, warning: "Files a filter program rewrites could not be checked for changes, and are deleted as they are.", loss: "unchecked", lossText: "any changes to files Git was told not to look at"},
}

type removalFacts struct {
	reasons  []reasonCode
	verified bool
	problems bool
	merged   bool
	// fresh withholds only the recommendation; it never blocks manual removal.
	fresh bool
}
type removalDecision struct {
	canRemove   bool
	canDiscard  bool
	recommended bool
	warnings    []string
	losses      []string
}

// evaluateRemoval has no Git/filesystem dependencies. Display strings are never
// inputs: only completed inspection facts and typed reasons authorize cleanup.
func evaluateRemoval(facts removalFacts) removalDecision {
	if !facts.verified || facts.problems {
		return removalDecision{}
	}
	decision := removalDecision{canRemove: len(facts.reasons) == 0, canDiscard: true}
	decision.recommended = decision.canRemove && facts.merged && !facts.fresh
	for _, reason := range facts.reasons {
		if reason >= reasonCount || !reasonDescriptions[reason].manual {
			return removalDecision{}
		}
		if warning := reasonDescriptions[reason].warning; warning != "" {
			decision.warnings = append(decision.warnings, warning)
		}
		if loss := reasonDescriptions[reason].loss; loss != "" {
			decision.losses = append(decision.losses, loss)
		}
	}
	return decision
}

func reasonMessage(reason reasonCode) string {
	if reason >= reasonCount {
		return "Cannot verify removal eligibility"
	}
	return reasonDescriptions[reason].message
}

// RecoveryBranch names a branch without incorporating path text or user input.
// Include the commit so repeated detached checkouts cannot overwrite old work.
func RecoveryBranch(w Worktree) string {
	sum := sha256.Sum256([]byte(w.CommonDir + "\x00" + w.Path + "\x00" + w.Head))
	return fmt.Sprintf("arbor/retained/%x", sum[:12])
}

// GraveLosses lists the losses that must each be agreed to by name.
func GraveLosses() []string {
	var names []string
	for _, description := range reasonDescriptions {
		if description.grave {
			names = append(names, description.loss)
		}
	}
	return names
}

// unacknowledged describes the grave losses in a worktree that the person
// deleting it has not been shown and accepted, or is empty when there are
// none. What they agreed to was what they saw.
func unacknowledged(losses, acknowledged []string) string {
	var missing []string
	for _, description := range reasonDescriptions {
		if description.grave && slices.Contains(losses, description.loss) && !slices.Contains(acknowledged, description.loss) {
			missing = append(missing, description.lossText)
		}
	}
	return strings.Join(missing, "; ")
}
