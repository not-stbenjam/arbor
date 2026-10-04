package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

func inspect(ctx context.Context, w *Worktree, options Options) {
	inspectWithDefault(ctx, w, options, nil)
}

// inspectWithDefault assembles facts in explicit stages and evaluates removal
// policy once. No intermediate metadata stage grants permission to remove.
func inspectWithDefault(ctx context.Context, w *Worktree, options Options, defaultCache *repositoryDefault) {
	w.Missing = false
	w.Empty = false
	w.Blockers = []string{}
	w.Problems = []string{}
	w.PublishedRefs = []string{}
	w.GitHubState = "not_checked"
	var reasons []reasonCode
	verified := false
	block := func(reason reasonCode) { reasons = append(reasons, reason) }
	defer func() {
		for _, reason := range reasons {
			w.Blockers = append(w.Blockers, reasonMessage(reason))
		}
		decision := evaluateRemoval(removalFacts{reasons: reasons, verified: verified, problems: len(w.Problems) > 0, merged: w.Merged})
		w.CanRemove, w.CanDiscard, w.Recommended = decision.canRemove, decision.canDiscard, decision.recommended
		w.DiscardWarnings = decision.warnings
	}()
	location := inspectLocation(ctx, w, block)
	if location != inspectionCheckout {
		verified = location == inspectionRegistration
		return
	}
	inspectCommit(ctx, w)
	inspectStatus(ctx, w, block)
	inspectIndex(ctx, w, block)
	inspectActivity(ctx, w, block)
	inspectPublication(ctx, w)
	inspectMerge(ctx, w, defaultCache, block)
	if options.GitHub {
		checkGitHub(ctx, w)
	}
	verified = true
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
