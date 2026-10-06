package worktree

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

func inspect(ctx context.Context, w *Worktree, options Options) inspectionDetails {
	return inspectWithDefault(ctx, w, options, nil)
}

// inspectionDetails is what an inspection learned that a removal looks at
// once more, at the last moment, without inspecting everything again.
type inspectionDetails struct {
	// submodules are the folders of the submodules that are checked out.
	submodules []string
	// markers are the files and folders Git keeps while an operation such
	// as a rebase or a cherry-pick is unfinished.
	markers []string
	// modules is where Git keeps the repositories of this worktree's
	// submodules. It is part of the repository, not of the worktree's
	// folder, and goes with the worktree all the same.
	modules string
}

// inspectWithDefault assembles facts in explicit stages and evaluates removal
// policy once. No intermediate metadata stage grants permission to remove.
func inspectWithDefault(ctx context.Context, w *Worktree, options Options, defaultCache *repositoryDefault) (details inspectionDetails) {
	w.Missing = false
	w.Empty = false
	w.Fresh = false
	w.Blockers = []string{}
	w.Problems = []string{}
	w.PublishedRefs = []string{}
	w.GitHubState = "not_checked"
	var reasons []reasonCode
	verified := false
	// More than one stage can find the same reason; it is given once.
	block := func(reason reasonCode) {
		if !slices.Contains(reasons, reason) {
			reasons = append(reasons, reason)
		}
	}
	defer func() {
		for _, reason := range reasons {
			w.Blockers = append(w.Blockers, reasonMessage(reason))
		}
		decision := evaluateRemoval(removalFacts{reasons: reasons, verified: verified, problems: len(w.Problems) > 0, merged: w.Merged, fresh: w.Fresh})
		w.CanRemove, w.CanDiscard, w.Recommended = decision.canRemove, decision.canDiscard, decision.recommended
		w.DiscardWarnings = decision.warnings
		w.Losses = decision.losses
		if w.Losses == nil {
			w.Losses = []string{}
		}
	}()
	location := inspectLocation(ctx, w, block)
	if location != inspectionCheckout {
		verified = location == inspectionRegistration
		if verified {
			// The folder is gone or empty, but what Git kept for it is not.
			// A submodule's repository there can hold commits that were
			// never pushed, and an unfinished rebase its saved changes.
			// Removing the registration removes both.
			if admin := adminDirectory(w.CommonDir, w.Path); admin != "" {
				details.modules = filepath.Join(admin, "modules")
				if holdsSubmodules(details.modules) {
					block(reasonSubmodules)
				}
				for _, marker := range operationMarkers {
					details.markers = append(details.markers, filepath.Join(admin, marker))
				}
				if unfinished(details.markers) {
					block(reasonOperation)
				}
				// Its own refs outlive its folder too, until it is removed.
				inspectPrivateRefs(ctx, w, w.CommonDir, []string{"--git-dir=" + admin}, block)
			}
		}
		return
	}
	// From here Git compares files with what is committed, and would run
	// the filter programs this worktree's configuration names. They are
	// switched off, and with them off what such a filter rewrites cannot be
	// checked, so the worktree is not a clean delete.
	if off, names := repositoryFilters(ctx, w.Path); len(off) > 0 {
		defer holdFilters(w.Path, off)()
		defaultCache.noteFilters(names)
		block(reasonFilterOff)
	}
	inspectCommit(ctx, w)
	inspectStatus(ctx, w, block)
	details.submodules = inspectIndex(ctx, w, block)
	details.markers, details.modules = inspectActivity(ctx, w, block, details.submodules)
	inspectPublication(ctx, w)
	decided := inspectMerge(ctx, w, defaultCache, block)
	if options.GitHub {
		checkGitHub(ctx, w, decided, block)
	}
	if w.Merged {
		inspectFreshness(ctx, w)
	}
	verified = true
	return details
}

type inspectionLocation uint8

const (
	inspectionUnverified   inspectionLocation = iota
	inspectionRegistration                    // Verified missing/empty registration; no checkout to inspect.
	inspectionCheckout
)

// inspectLocation verifies path ownership before any checkout-level Git reads.
// Git's prunable marker can also describe an existing empty directory, so only
// the actual filesystem state selects the missing/empty registration path.
func inspectLocation(ctx context.Context, w *Worktree, block func(reasonCode)) inspectionLocation {
	if !utf8.ValidString(w.Path) {
		block(reasonPathText)
		return inspectionUnverified
	}
	if w.Main {
		block(reasonPrimary)
	}
	if w.Bare {
		block(reasonBare)
		return inspectionUnverified
	}
	if w.OutsideRoot {
		block(reasonOutside)
	}
	if w.Locked {
		block(reasonLocked)
	}
	if w.Detached {
		block(reasonDetached)
	}
	if st, err := os.Stat(w.Path); err != nil || !st.IsDir() {
		w.Missing = true
		block(reasonMissing)
		if os.IsNotExist(err) {
			canonical, pathErr := resolveMissingRoot(w.Path)
			if pathErr != nil || canonical != w.Path {
				block(reasonUnverifiedPath)
			} else {
				return inspectRegistrationCommit(ctx, w, block)
			}
		}
		return inspectionUnverified
	}
	// Resolve both properties in one Git process. Copied repositories can retain
	// registrations pointing at another repository's checkout. Matching the
	// expected prefix also preserves embedded newlines in path names.
	identity, identityErr := git(ctx, w.Path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
	common, ownsPath := strings.CutPrefix(identity, w.Path+"\n")
	if identityErr != nil || !ownsPath {
		if emptyCheckoutDirectory(w.Path) {
			w.Empty = true
			block(reasonEmpty)
			return inspectRegistrationCommit(ctx, w, block)
		}
		block(reasonUnverifiedPath)
		return inspectionUnverified
	}
	actualCommon, commonErr := filepath.EvalSymlinks(strings.TrimSuffix(common, "\n"))
	if commonErr != nil || actualCommon != w.CommonDir {
		block(reasonUnverifiedPath)
		return inspectionUnverified
	}
	w.Head = gitText(ctx, w.Path, "rev-parse", "--verify", "HEAD")
	if len(w.Head) < 40 {
		block(reasonNoCommit)
		return inspectionUnverified
	}
	return inspectionCheckout
}

func inspectRegistrationCommit(ctx context.Context, w *Worktree, block func(reasonCode)) inspectionLocation {
	if len(w.Head) < 40 || gitCommonText(ctx, w.CommonDir, "rev-parse", "--verify", w.Head+"^{commit}") != w.Head {
		block(reasonNoCommit)
		return inspectionUnverified
	}
	return inspectionRegistration
}
