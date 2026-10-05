package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/engine"
	"github.com/stbenjam/arbor/internal/worktree"
)

func TestBatchCancellationRetainsCompletedOutcome(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	targets := []worktree.Worktree{{Path: "/one", Head: "one"}, {Path: "/two", Head: "two"}}
	calls := 0
	remove := func(_ context.Context, request engine.RemovalRequest) (worktree.RemovalResult, error) {
		calls++
		if request.Host != "vps" || request.SessionID != "batch" || request.Options.ExpectedHead != "one" || !request.Options.DiscardLocal {
			t.Fatalf("request lost policy: %+v", request)
		}
		cancel()
		return worktree.RemovalResult{Path: request.Worktree.Path, Removed: true}, nil
	}
	outcome := executeBatch(ctx, worktreeRequest{command: "clean", host: "vps", all: true, discardLocal: true}, targets, "batch", remove, nil)
	if calls != 1 || len(outcome.removed) != 1 || len(outcome.results) != 1 || !errors.Is(outcome.err, context.Canceled) {
		t.Fatalf("unexpected partial outcome: %+v calls=%d", outcome, calls)
	}
}

func TestBatchPartialFailureAndObserverFailure(t *testing.T) {
	targets := []worktree.Worktree{{Path: "/one"}, {Path: "/two"}}
	remove := func(_ context.Context, request engine.RemovalRequest) (worktree.RemovalResult, error) {
		if request.Worktree.Path == "/one" {
			return worktree.RemovalResult{Path: "/one"}, errors.New("unavailable")
		}
		return worktree.RemovalResult{Path: "/two", Removed: true}, nil
	}
	outcome := executeBatch(context.Background(), worktreeRequest{}, targets, "batch", remove, nil)
	if len(outcome.results) != 2 || len(outcome.removed) != 1 || outcome.err == nil {
		t.Fatalf("lost partial result: %+v", outcome)
	}
	brokenOutput := errors.New("output closed")
	outcome = executeBatch(context.Background(), worktreeRequest{}, targets[1:], "batch", remove, func(worktree.Worktree, worktree.RemovalResult) error { return brokenOutput })
	if len(outcome.removed) != 1 || !errors.Is(outcome.err, brokenOutput) {
		t.Fatalf("successful deletion lost on output error: %+v", outcome)
	}
}

func TestNormalizedCleanupModes(t *testing.T) {
	for _, tc := range []struct {
		command              string
		flags                commandOptions
		discard, recommended bool
	}{
		// Consent to run is not consent to discard: only --force, or the
		// desktop's --discard-local, permits losing local files.
		{"remove", commandOptions{}, false, false}, {"remove", commandOptions{keepLocal: true}, false, false},
		{"remove", commandOptions{force: true}, true, false}, {"remove", commandOptions{discardLocal: true}, true, false},
		{"clean", commandOptions{}, false, true}, {"clean", commandOptions{all: true}, false, false},
		{"clean", commandOptions{all: true, force: true}, true, false},
		{"remove", commandOptions{recommended: true}, false, true},
	} {
		r, err := normalizeRequest(tc.command, &tc.flags)
		if err != nil || r.discardLocal != tc.discard || r.recommendedRemoval() != tc.recommended {
			t.Fatalf("incorrect normalization: %+v %v", r, err)
		}
	}
	for _, flags := range []commandOptions{{force: true}, {force: true, yes: true}} {
		if _, err := normalizeRequest("clean", &flags); err == nil || !strings.Contains(err.Error(), "--all") {
			t.Fatalf("clean --force without --all must explain itself: %v", err)
		}
	}
}
