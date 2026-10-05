package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

func writeList(out io.Writer, r worktreeRequest, report worktree.Report) error {
	if r.recommended {
		filtered := []worktree.Worktree{}
		for _, w := range report.Worktrees {
			if w.Recommended {
				filtered = append(filtered, w)
			}
		}
		report.Worktrees = filtered
	}
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
	return printTable(out, report.Worktrees)
}

func writePreview(out io.Writer, r worktreeRequest, selected []worktree.Worktree, warnings []string) error {
	if r.json {
		return json.NewEncoder(out).Encode(map[string]any{"dryRun": true, "worktrees": selected, "warnings": warnings})
	}
	if len(selected) == 0 {
		_, err := fmt.Fprintln(out, "No matching worktrees to remove. Nothing changed.")
		return err
	}
	if err := printTable(out, selected); err != nil {
		return err
	}
	if r.discardLocal {
		for _, w := range selected {
			for _, warning := range w.DiscardWarnings {
				if _, err := fmt.Fprintf(out, "%s: %s\n", printable(w.Path), printable(warning)); err != nil {
					return err
				}
			}
		}
	}
	_, err := fmt.Fprintf(out, "\nPreview only: %s, %s on disk. Pass --yes to remove; branches are retained.\n", count(len(selected), "worktree"), byteSize(totalSize(selected)))
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

func printTable(out io.Writer, entries []worktree.Worktree) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PATH\tBRANCH\tREPOSITORY\tACTIVITY\tSIZE\tSTATUS")
	for _, entry := range entries {
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
		size := "—"
		if !entry.Missing {
			size = byteSize(entry.SizeBytes)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", printable(entry.Path), printable(branch), printable(entry.Repo), age, size, status(entry))
	}
	return w.Flush()
}

// status names the one fact that most affects a cleanup decision.
func status(entry worktree.Worktree) string {
	switch {
	case !entry.CanRemove && !entry.CanDiscard && len(entry.Blockers) > 0:
		return printable(entry.Blockers[0])
	case entry.Missing:
		return "missing checkout"
	case entry.Empty:
		return "empty checkout"
	case entry.Dirty:
		return "local changes"
	case entry.Ignored:
		return "ignored files"
	case entry.Locked:
		return "Git locked"
	case entry.Fresh:
		return "new"
	case entry.Merged:
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
