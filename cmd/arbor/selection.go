package main

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/stbenjam/arbor/internal/worktree"
)

type targetSelection struct {
	selected []worktree.Worktree
	skipped  []worktree.Worktree
	// needsForce reports a previewed target that --yes alone will not remove.
	needsForce bool
}

// reasons is why a worktree cannot simply be removed, in the scan's words.
func reasons(w worktree.Worktree) string {
	return strings.Join(append(slices.Clone(w.Blockers), w.Problems...), "; ")
}

// selectTargets is pure: it evaluates the inspected report against command intent.
func selectTargets(r worktreeRequest, report worktree.Report) (targetSelection, error) {
	selection := targetSelection{selected: []worktree.Worktree{}}
	if r.command == "clean" {
		for _, w := range report.Worktrees {
			if w.Recommended || r.all && (w.CanRemove || r.discardLocal && w.CanDiscard) {
				selection.selected = append(selection.selected, w)
			} else if r.all {
				selection.skipped = append(selection.skipped, w)
			}
		}
		return selection, nil
	}
	for _, w := range report.Worktrees {
		if w.Path == report.Root {
			selection.selected = append(selection.selected, w)
			break
		}
	}
	if len(selection.selected) != 1 {
		return selection, errors.New("path is not a linked worktree (primary checkouts and folders inside a worktree are never removed); for an empty or missing checkout, supply --repo with its owning repository")
	}
	w := selection.selected[0]
	if r.expectMissing && !w.Missing {
		return selection, errors.New("worktree directory appeared after confirmation; inspect it again")
	}
	if r.expectEmpty && !w.Empty && !w.Missing {
		return selection, errors.New("checkout is no longer empty after confirmation; inspect it again")
	}
	if r.head != "" && r.head != w.Head {
		return selection, errors.New("commit changed; scan again")
	}
	if r.id != "" && r.id != w.ID {
		return selection, errors.New("worktree identity changed; scan again")
	}
	if r.expectBranch && r.branch != w.Branch {
		return selection, errors.New("branch changed; scan again")
	}
	if !w.CanRemove && !w.CanDiscard {
		return selection, fmt.Errorf("cannot remove: %s", reasons(w))
	}
	if !w.CanRemove && !r.discardLocal {
		// A preview still shows the target and what --force would discard.
		// Carrying it out without --force is refused, as Git refuses it.
		if !r.preview {
			return selection, fmt.Errorf("not removed: %s. Add --force to remove it anyway; run without --yes first to see what that involves", reasons(w))
		}
		selection.needsForce = true
	}
	if r.recommended && !w.Recommended {
		return selection, errors.New("worktree is not a cleanup recommendation")
	}
	return selection, nil
}
