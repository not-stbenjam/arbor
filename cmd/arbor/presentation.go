package main

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/stbenjam/arbor/internal/worktree"
)

func writeList(out io.Writer, r worktreeRequest, report worktree.Report) error {
	if r.recommended || !r.notActiveSince.IsZero() {
		filtered := []worktree.Worktree{}
		for _, w := range report.Worktrees {
			if (!r.recommended || w.Recommended) && matchesAge(w, r.notActiveSince) {
				filtered = append(filtered, w)
			}
		}
		report.Worktrees = filtered
	}
	report.Worktrees = sortedWorktrees(report.Worktrees, r.sortOrder)
	if r.json {
		return json.NewEncoder(out).Encode(report)
	}
	if len(report.Worktrees) == 0 {
		qualifier := ""
		if r.recommended {
			qualifier = "recommended "
		}
		_, err := fmt.Fprintf(out, "No %sworktrees found under %s.\n", qualifier, printable(report.Root))
		return err
	}
	return printTable(out, report.Root, report.Worktrees)
}

func writePreview(out io.Writer, r worktreeRequest, report worktree.Report, selection targetSelection) error {
	selected := sortedWorktrees(selection.selected, r.sortOrder)
	if r.json {
		return json.NewEncoder(out).Encode(map[string]any{"dryRun": true, "worktrees": selected, "warnings": report.Warnings, "requiresForce": selection.needsForce})
	}
	if len(selected) == 0 {
		_, err := fmt.Fprintln(out, "No matching worktrees to remove. Nothing changed.")
		return err
	}
	if err := printTable(out, report.Root, selected); err != nil {
		return err
	}
	// Say what would be lost wherever that is the question: when --force was
	// given, and when it would have to be.
	if r.discardLocal || selection.needsForce {
		for _, w := range selected {
			for _, warning := range w.DiscardWarnings {
				if _, err := fmt.Fprintf(out, "%s: %s\n", printable(w.Path), printable(warning)); err != nil {
					return err
				}
			}
		}
	}
	consent := "--yes"
	if selection.needsForce {
		consent = "--force --yes"
	}
	_, err := fmt.Fprintf(out, "\nPreview only: %s, %s on disk. Pass %s to remove; branches are kept.\n", count(len(selected), "worktree"), byteSize(totalSize(selected)), consent)
	return err
}

func writeRemoval(out, stderr io.Writer, w worktree.Worktree, result worktree.RemovalResult) error {
	if !result.Removed {
		fmt.Fprintln(stderr, printable(w.Path)+":", printable(result.Error))
		if result.RetainedBranch != "" {
			fmt.Fprintln(stderr, printable(w.Path)+": commit retained on", printable(result.RetainedBranch))
		}
		return nil
	}
	retention := "(branch retained)"
	if result.RetainedBranch != "" {
		retention = "(commit retained on " + printable(result.RetainedBranch) + ")"
	} else if w.Detached {
		retention = "(commit retained)"
	}
	_, err := fmt.Fprintln(out, "Removed", printable(w.Path), retention)
	return err
}

func writeOutcome(out io.Writer, r worktreeRequest, outcome batchOutcome) error {
	if r.json {
		var value any = outcome.results
		if r.command == "remove" {
			if len(outcome.results) == 0 {
				return outcome.err
			}
			value = outcome.results[0]
		}
		if err := json.NewEncoder(out).Encode(value); err != nil {
			return err
		}
	} else if len(outcome.results) == 0 && outcome.err == nil {
		if _, err := fmt.Fprintln(out, "No matching worktrees to remove. Nothing changed."); err != nil {
			return err
		}
	} else if len(outcome.results) > 1 {
		// Each removal already printed its own line; total a batch once.
		if _, err := fmt.Fprintf(out, "Removed %d of %s, freeing about %s.\n", len(outcome.removed), count(len(outcome.results), "worktree"), byteSize(totalSize(outcome.removed))); err != nil {
			return err
		}
	}
	return outcome.err
}

// printTable lists worktrees for reading. Every path under the scanned folder
// repeats that folder, so it is named once and the rows are relative to it;
// --json keeps complete paths for programs.
func printTable(out io.Writer, root string, entries []worktree.Worktree) error {
	relative := false
	paths := make([]string, len(entries))
	for i, entry := range entries {
		paths[i] = entry.Path
		if rel, err := filepath.Rel(root, entry.Path); root != "" && err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			paths[i], relative = rel, true
		}
	}
	if relative {
		if _, err := fmt.Fprintf(out, "Under %s:\n", printable(root)); err != nil {
			return err
		}
	}
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PATH\tBRANCH\tREPOSITORY\tACTIVITY\tSIZE\tSTATUS")
	for i, entry := range entries {
		branch := shorten(entry.Branch, 40)
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
		size := "—"
		if !entry.Missing {
			size = byteSize(entry.SizeBytes)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", printable(paths[i]), printable(branch), printable(entry.Repo), age, size, status(entry))
	}
	return w.Flush()
}

// shorten keeps both ends of a long name, where branch names differ.
func shorten(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	head := (limit - 1) / 2
	return string(runes[:head]) + "…" + string(runes[len(runes)-(limit-1-head):])
}

// status names the one fact that most affects a cleanup decision. "merged"
// means what clean removes: merged, and nothing else in the way.
// status is the one thing about a worktree that decides its cleanup. Nothing
// with something to lose is ever called clean, and the gravest loss is named.
func status(entry worktree.Worktree) string {
	if !entry.CanRemove && !entry.CanDiscard && len(entry.Blockers) > 0 {
		return printable(entry.Blockers[0])
	}
	// A missing folder can still leave submodule history or an unfinished
	// operation in Git's metadata. Name that loss before the absent folder,
	// as the desktop does; the disappearance of files does not remove it.
	for _, loss := range []struct{ name, label string }{
		{"nested", "nested repository"},
		{"submodules", "submodules"},
		{"operation", "unfinished operation"},
	} {
		if slices.Contains(entry.Losses, loss.name) {
			return loss.label
		}
	}
	switch {
	case entry.Missing:
		return "missing checkout"
	case entry.Empty:
		return "empty checkout"
	}
	for _, loss := range []struct{ name, label string }{
		{"changes", "local changes"},
		{"unchecked", "unchecked files"},
		{"ignored", "ignored files"},
	} {
		if slices.Contains(entry.Losses, loss.name) {
			return loss.label
		}
	}
	switch {
	case entry.Dirty:
		return "local changes"
	case entry.Ignored:
		return "ignored files"
	case entry.Locked:
		return "Git locked"
	case entry.Detached:
		return "detached"
	case !entry.CanRemove && len(entry.Blockers) > 0:
		// Whatever else only --force gets past, in the words before its
		// explanation: a default or protected branch.
		brief, _, _ := strings.Cut(entry.Blockers[0], ":")
		return printable(strings.ToLower(brief))
	case entry.Fresh:
		return "new"
	case entry.Recommended:
		return "merged"
	}
	return "clean"
}

func totalSize(entries []worktree.Worktree) int64 {
	var total int64
	for _, entry := range entries {
		if !entry.Missing && entry.SizeBytes > 0 {
			total += entry.SizeBytes
		}
	}
	return total
}

func count(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
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

// Stable ties keep the scan's repository/path order, also used by --sort name.
func sortedWorktrees(entries []worktree.Worktree, order string) []worktree.Worktree {
	result := slices.Clone(entries)
	slices.SortStableFunc(result, func(a, b worktree.Worktree) int {
		switch order {
		case "size":
			if a.SizeBytes > b.SizeBytes {
				return -1
			}
			if a.SizeBytes < b.SizeBytes {
				return 1
			}
		case "activity":
			if a.ActivityAt.IsZero() && !b.ActivityAt.IsZero() {
				return 1
			}
			if b.ActivityAt.IsZero() && !a.ActivityAt.IsZero() {
				return -1
			}
			return a.ActivityAt.Compare(b.ActivityAt)
		}
		return 0
	})
	return result
}
