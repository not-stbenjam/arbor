package main

import (
	"context"
	"errors"

	"github.com/stbenjam/arbor/internal/engine"
	"github.com/stbenjam/arbor/internal/worktree"
)

type removalService func(context.Context, engine.RemovalRequest) (worktree.RemovalResult, error)
type removalObserver func(worktree.Worktree, worktree.RemovalResult) error
type batchOutcome struct {
	results []worktree.RemovalResult
	removed []worktree.Worktree
	err     error
}

// executeBatch owns sequencing, cancellation, and outcomes, not persistence or presentation.
func executeBatch(ctx context.Context, r worktreeRequest, targets []worktree.Worktree, sessionID string, remove removalService, observe removalObserver) batchOutcome {
	outcome := batchOutcome{results: []worktree.RemovalResult{}}
	failed := false
	for _, w := range targets {
		if ctx.Err() != nil {
			break
		}
		result, err := remove(ctx, engine.RemovalRequest{Host: r.host, Worktree: w, SessionID: sessionID,
			Options: worktree.RemovalOptions{NotActiveSince: r.notActiveSince, ExpectedHead: w.Head, RecommendedOnly: r.recommendedRemoval(), DiscardLocal: r.discardLocal, Acknowledged: r.acknowledged}})
		if err != nil {
			result.Error = err.Error()
			failed = true
		}
		outcome.results = append(outcome.results, result)
		if result.Removed {
			outcome.removed = append(outcome.removed, w)
		}
		if observe != nil {
			if err := observe(w, result); err != nil {
				outcome.err = err
				return outcome
			}
		}
	}
	if ctx.Err() != nil {
		outcome.err = ctx.Err()
	} else if failed {
		outcome.err = errors.New("some worktrees could not be removed")
	}
	return outcome
}
