package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/not-stbenjam/arbor/internal/engine"
	"github.com/not-stbenjam/arbor/internal/worktree"
)

// runWorktrees composes validation, inspection, selection, execution, and output.
func runWorktrees(ctx context.Context, command string, flags *commandOptions, stdout, stderr io.Writer) error {
	r, err := normalizeRequest(command, flags)
	if err != nil {
		return err
	}
	if r.watchStdin {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		defer watchInput(ctx, os.Stdin, cancel)()
	}
	status := newScanStatus(stderr, r.humanProgress)
	status.start(r.scan.Root, r.host)
	options := r.scan
	if r.progress {
		options.Progress = func(event worktree.Progress) {
			if data, err := json.Marshal(event); err == nil {
				fmt.Fprintf(stderr, "%s%s\n", worktree.ProgressPrefix, data)
			}
		}
	} else if status.enabled {
		options.Progress = status.update
	}
	report, err := engine.Scan(ctx, r.host, options)
	if err != nil {
		return err
	}
	status.finish(report)
	// A JSON list carries its own warnings. Cleanup results do not, and an
	// incomplete scan must never look like a clean folder with nothing to do.
	if !r.json || command != "list" {
		for _, warning := range report.Warnings {
			fmt.Fprintln(stderr, "Warning:", printable(warning))
		}
	}
	if command == "list" {
		return writeList(stdout, r, report)
	}
	selection, err := selectTargets(r, report)
	if err != nil {
		return err
	}
	for _, w := range selection.skipped {
		fmt.Fprintf(stderr, "Skipped %s: %s\n", printable(w.Path), printable(strings.Join(append(w.Blockers, w.Problems...), "; ")))
	}
	if r.preview {
		return writePreview(stdout, r, selection.selected, report.Warnings)
	}
	batchID := rand.Text()
	sessionID := r.sessionID
	if sessionID == "" {
		sessionID = batchID
	}
	remove := func(ctx context.Context, target engine.RemovalRequest) (worktree.RemovalResult, error) {
		if status.enabled {
			fmt.Fprintln(stderr, "Removing", printable(target.Worktree.Path)+"…")
		}
		return engine.RemoveWorktree(ctx, target)
	}
	var observe removalObserver
	if !r.json {
		observe = func(w worktree.Worktree, result worktree.RemovalResult) error {
			return writeRemoval(stdout, stderr, w, result)
		}
	}
	outcome := executeBatch(ctx, r, selection.selected, sessionID, remove, observe)
	recordOutcome(r.host, batchID, sessionID, outcome, stderr)
	return writeOutcome(stdout, r, outcome)
}
