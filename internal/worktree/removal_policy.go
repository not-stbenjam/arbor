package worktree

import (
	"crypto/sha256"
	"fmt"
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
	reasonSparse
	reasonSubmodules
	reasonMetadata
	reasonOperation
	reasonDefaultBranch
	reasonProtectedBranch
	reasonNested
	reasonFiles
	reasonCount
)

type reasonDescription struct {
	message string
	manual  bool
	warning string
}

var reasonDescriptions = [...]reasonDescription{
	reasonPrimary:             {message: "Primary worktree"},
	reasonBare:                {message: "Bare repository"},
	reasonOutside:             {message: "Outside the scan folder"},
	reasonLocked:              {message: "Locked worktree", manual: true, warning: "The Git worktree lock will be overridden."},
	reasonDetached:            {message: "Detached HEAD; create a branch to retain its commits", manual: true, warning: "The detached commit will be retained; a recovery branch is created only if needed."},
	reasonMissing:             {message: "Worktree directory is missing", manual: true, warning: "Only this missing worktree's Git registration will be removed; branches and commits are retained."},
	reasonUnverifiedPath:      {message: "Worktree path could not be verified"},
	reasonNoCommit:            {message: "No commit to preserve"},
	reasonEmpty:               {message: "Empty checkout directory; only its stale registration remains", manual: true, warning: "Only the empty directory and its stale Git registration will be removed; branches and commits are retained."},
	reasonStatus:              {message: "Cannot read working directory status"},
	reasonDirty:               {message: "Uncommitted or untracked files", manual: true, warning: "Uncommitted changes and untracked files will be deleted."},
	reasonIgnored:             {message: "Ignored files on disk (may include local secrets or build output)", manual: true, warning: "Ignored files will be deleted, including any local configuration or build output."},
	reasonIndex:               {message: "Cannot verify index flags"},
	reasonSubmoduleInspection: {message: "Cannot verify submodules"},
	reasonSparse:              {message: "Sparse or assume-unchanged index entries"},
	reasonSubmodules:          {message: "Contains submodules"},
	reasonMetadata:            {message: "Cannot locate Git metadata"},
	reasonOperation:           {message: "Git operation in progress"},
	reasonDefaultBranch:       {message: "Default branch", manual: true},
	reasonProtectedBranch:     {message: "Protected branch name", manual: true},
	reasonNested:              {message: "Contains a nested repository or worktree"},
	reasonFiles:               {message: "Cannot inspect every file"},
}

type removalFacts struct {
	reasons  []reasonCode
	verified bool
	problems bool
	merged   bool
}
type removalDecision struct {
	canRemove   bool
	canDiscard  bool
	recommended bool
	warnings    []string
}

// evaluateRemoval has no Git/filesystem dependencies. Display strings are never
// inputs: only completed inspection facts and typed reasons authorize cleanup.
func evaluateRemoval(facts removalFacts) removalDecision {
	if !facts.verified || facts.problems {
		return removalDecision{}
	}
	decision := removalDecision{canRemove: len(facts.reasons) == 0, canDiscard: true}
	decision.recommended = decision.canRemove && facts.merged
	for _, reason := range facts.reasons {
		if reason >= reasonCount || !reasonDescriptions[reason].manual {
			return removalDecision{}
		}
		if warning := reasonDescriptions[reason].warning; warning != "" {
			decision.warnings = append(decision.warnings, warning)
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
