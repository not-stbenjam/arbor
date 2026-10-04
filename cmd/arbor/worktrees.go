package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/not-stbenjam/arbor/internal/engine"
	"github.com/not-stbenjam/arbor/internal/stats"
	"github.com/not-stbenjam/arbor/internal/worktree"
)

var cleanupSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func runWorktrees(ctx context.Context, command string, flags *commandOptions, stdout, stderr io.Writer) error {
	common := flags.common
	yes, recommended, progress, all := flags.yes, flags.recommended, flags.progress, flags.all
	linkedOnly, noDefaultExcludes := flags.linkedOnly, flags.noDefaultExcludes
	discardLocal, keepLocal := flags.discardLocal || flags.force, flags.keepLocal
	targetOnly, watchStdin := flags.targetOnly, flags.watchStdin
	excludes := flags.excludes
	head, id, branch := flags.head, flags.id, flags.branch
	policyFlag := "--discard-local"
	if flags.force {
		policyFlag = "--force"
	}
	if discardLocal && recommended {
		return fmt.Errorf("%s cannot be combined with --recommended-only", policyFlag)
	}
	if discardLocal && keepLocal {
		return fmt.Errorf("%s and --keep-local are mutually exclusive", policyFlag)
	}
	if flags.expectMissing && flags.expectEmpty {
		return errors.New("--expect-missing and --expect-empty are mutually exclusive")
	}
	if flags.statsSession != "" && !cleanupSessionPattern.MatchString(flags.statsSession) {
		return errors.New("--stats-session must contain 1–128 letters, digits, hyphens, or underscores")
	}
	// An explicit remove is the CLI counterpart of the desktop Delete action.
	// --yes confirms disposing of this checkout's local files; without it, preview.
	discardLocal = discardLocal || (command == "remove" && !recommended && !keepLocal) || (command == "clean" && all)
	if watchStdin {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		stopWatching := watchInput(ctx, os.Stdin, cancel)
		defer stopWatching()
	}
	if err := engine.ValidateHost(common.host); err != nil {
		return err
	}
	options := common.options()
	options.Repository = flags.repository
	options.LinkedOnly = linkedOnly
	options.TargetOnly = command == "remove" || targetOnly
	if noDefaultExcludes || len(excludes) > 0 {
		options.Excludes = []string{}
		if !noDefaultExcludes {
			options.Excludes = append(options.Excludes, worktree.DefaultExcludes()...)
		}
		options.Excludes = append(options.Excludes, excludes...)
	}
	status := newScanStatus(stderr, !common.json && !flags.quiet && !progress)
	status.start(common.root, common.host)
	if progress {
		options.Progress = func(event worktree.Progress) {
			if data, err := json.Marshal(event); err == nil {
				fmt.Fprintf(stderr, "%s%s\n", worktree.ProgressPrefix, data)
			}
		}
	} else if status.enabled {
		options.Progress = status.update
	}
	report, err := engine.Scan(ctx, common.host, options)
	if err != nil {
		return err
	}
	status.finish(report)
	if !common.json {
		for _, warning := range report.Warnings {
			fmt.Fprintln(stderr, "Warning:", printable(warning))
		}
	}
	if command == "list" {
		if recommended {
			filtered := []worktree.Worktree{}
			for _, w := range report.Worktrees {
				if w.Recommended {
					filtered = append(filtered, w)
				}
			}
			report.Worktrees = filtered
		}
		if common.json {
			return json.NewEncoder(stdout).Encode(report)
		}
		if len(report.Worktrees) == 0 {
			_, err := fmt.Fprintf(stdout, "No %sworktrees found under %s.\n", map[bool]string{true: "recommended "}[recommended], printable(report.Root))
			return err
		}
		return printTable(stdout, report.Worktrees)
	}
	selected := []worktree.Worktree{}
	if command == "clean" {
		for _, w := range report.Worktrees {
			if w.Recommended || (all && (w.CanRemove || w.CanDiscard)) {
				selected = append(selected, w)
			} else if all && !common.json {
				fmt.Fprintf(stderr, "Skipped %s: %s\n", printable(w.Path), printable(strings.Join(append(w.Blockers, w.Problems...), "; ")))
			}
		}
	} else {
		// The report root is canonicalized on the target machine, including for SSH.
		for _, w := range report.Worktrees {
			if w.Path == report.Root {
				selected = append(selected, w)
				break
			}
		}
		if len(selected) != 1 {
			return errors.New("path is not a linked worktree; for an empty or missing checkout, supply --repo with its owning repository")
		}
		w := selected[0]
		// These expectations carry narrow consent from a cached GUI snapshot or
		// SSH caller across the subprocess boundary. Reuse this target inspection.
		if flags.expectMissing && !w.Missing {
			return errors.New("worktree directory appeared after confirmation; inspect it again")
		}
		if flags.expectEmpty && !w.Empty && !w.Missing {
			return errors.New("checkout is no longer empty after confirmation; inspect it again")
		}
		if head != "" && head != w.Head {
			return errors.New("commit changed; scan again")
		}
		if id != "" && id != w.ID {
			return errors.New("worktree identity changed; scan again")
		}
		if branch != "" && branch != w.Branch {
			return errors.New("branch changed; scan again")
		}
		if !w.CanRemove && !(discardLocal && w.CanDiscard) {
			return fmt.Errorf("cannot remove: %s", strings.Join(append(w.Blockers, w.Problems...), "; "))
		}
		if recommended && !w.Recommended {
			return errors.New("worktree is not a cleanup recommendation")
		}
	}
	if !yes {
		if common.json {
			return json.NewEncoder(stdout).Encode(map[string]any{"dryRun": true, "worktrees": selected})
		}
		if len(selected) == 0 {
			_, err := fmt.Fprintln(stdout, "No matching worktrees to remove. Nothing changed.")
			return err
		}
		if err := printTable(stdout, selected); err != nil {
			return err
		}
		if discardLocal {
			for _, w := range selected {
				for _, warning := range w.DiscardWarnings {
					if _, err := fmt.Fprintf(stdout, "%s: %s\n", printable(w.Path), printable(warning)); err != nil {
						return err
					}
				}
			}
		}
		_, err := fmt.Fprintf(stdout, "\nPreview only. %d worktree(s) eligible. Pass --yes to remove; branches are retained.\n", len(selected))
		return err
	}
	results := []worktree.RemovalResult{}
	batchID := rand.Text()
	sessionID := flags.statsSession
	if sessionID == "" {
		sessionID = batchID
	}
	batch := stats.Batch{ID: batchID, SessionID: sessionID}
	// Record only completed local removals. Remote CLI processes write their own
	// machine's history; the SSH client must not count those a second time.
	defer func() {
		if common.host == "" && len(batch.Removals) > 0 {
			if err := stats.RecordRemovalBatch(batch); err != nil {
				fmt.Fprintln(stderr, "Warning: cleanup completed but statistics could not be saved:", printable(err.Error()))
			}
		}
	}()
	failed := false
	for _, w := range selected {
		if ctx.Err() != nil {
			break
		}
		if status.enabled {
			fmt.Fprintln(stderr, "Removing", printable(w.Path)+"…")
		}
		result, err := engine.RemoveWithSession(ctx, common.host, w, w.Head, (command == "clean" && !all) || recommended, discardLocal, sessionID)
		if err != nil {
			result.Error = err.Error()
			failed = true
		}
		results = append(results, result)
		if result.Removed {
			batch.Removals = append(batch.Removals, stats.Removal{SizeBytes: w.SizeBytes, Missing: w.Missing, Detached: w.Detached})
		}
		if !common.json {
			if result.Removed {
				retention := "(branch retained)"
				if result.RetainedBranch != "" {
					retention = "(commit retained on " + printable(result.RetainedBranch) + ")"
				} else if w.Detached {
					retention = "(commit retained)"
				}
				if _, err := fmt.Fprintln(stdout, "Removed", printable(w.Path), retention); err != nil {
					return err
				}
			} else {
				fmt.Fprintln(stderr, printable(w.Path)+":", printable(result.Error))
				if result.RetainedBranch != "" {
					fmt.Fprintln(stderr, printable(w.Path)+": commit retained on", printable(result.RetainedBranch))
				}
			}
		}
	}
	if !common.json && len(selected) == 0 {
		if _, err := fmt.Fprintln(stdout, "No matching worktrees to remove. Nothing changed."); err != nil {
			return err
		}
	}
	if common.json {
		var value any = results
		if command == "remove" {
			if len(results) == 0 {
				return ctx.Err()
			}
			value = results[0]
		}
		if err := json.NewEncoder(stdout).Encode(value); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if failed {
		return errors.New("some worktrees could not be removed")
	}
	return nil
}

func printTable(out io.Writer, entries []worktree.Worktree) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PATH\tBRANCH\tREPOSITORY\tACTIVITY\tSTATUS")
	for _, entry := range entries {
		state := "clean"
		if entry.Merged {
			state = "merged"
		}
		if entry.Locked {
			state = "Git locked"
		}
		if entry.Ignored {
			state = "ignored files"
		}
		if entry.Dirty {
			state = "local changes"
		}
		if entry.Empty {
			state = "empty checkout"
		}
		if entry.Missing {
			state = "missing checkout"
		}
		if !entry.CanRemove && !entry.CanDiscard && len(entry.Blockers) > 0 {
			state = printable(entry.Blockers[0])
		}
		branch := entry.Branch
		if entry.Detached {
			branch = "(detached)"
		}
		if entry.Bare {
			branch = "(bare)"
		}
		age := "—"
		if !entry.ActivityAt.IsZero() {
			age = duration(time.Since(entry.ActivityAt))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", printable(entry.Path), printable(branch), printable(entry.Repo), age, state)
	}
	return w.Flush()
}

func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return '�'
		}
		return r
	}, s)
}
func duration(d time.Duration) string {
	if d < time.Minute {
		return "just now"
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(d.Hours()/24))
}
