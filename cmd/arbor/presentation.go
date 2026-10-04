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

func writePreview(out io.Writer, r worktreeRequest, selected []worktree.Worktree) error {
	if r.json {
		return json.NewEncoder(out).Encode(map[string]any{"dryRun": true, "worktrees": selected})
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
	_, err := fmt.Fprintf(out, "\nPreview only. %d worktree(s) eligible. Pass --yes to remove; branches are retained.\n", len(selected))
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
	}
	return outcome.err
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
