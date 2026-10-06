package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/stbenjam/arbor/internal/engine"
	"github.com/stbenjam/arbor/internal/worktree"
)

func newFilesCommand() *cobra.Command {
	flags := &commandOptions{}
	var host, repository string
	var limit int
	var asJSON, watchStdin, progress bool
	cmd := &cobra.Command{
		Use: "files PATH", Short: "Show what deleting one linked worktree would discard",
		Long:    "List what deleting a linked worktree would discard: files that are not\ncommitted, ignored files, and what Git keeps for that worktree alone, largest\nfirst under each heading. Nothing is changed.\n\nCounts are of everything, whether or not --limit left it out of the list. A\nsize is marked \"at least\" when adding it up took too long or a folder could\nnot be read. The same folder can be under more than one heading.",
		Example: "  arbor files /path/to/worktree\n  arbor files /missing/worktree --repo /path/to/repository --json\n  arbor files --host my-vps --limit 20 -- '~/projects/worktree'",
		Args:    checkedArgs(cobra.ExactArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := engine.ValidateHost(host); err != nil {
				return usageError(cmd, err)
			}
			if args[0] == "" {
				return usageError(cmd, errors.New("PATH must not be empty"))
			}
			if limit < 1 || limit > 10000 {
				return usageError(cmd, errors.New("--limit must be between 1 and 10000"))
			}
			ctx := cmd.Context()
			if watchStdin {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				defer cancel()
				defer watchInput(ctx, os.Stdin, cancel)()
			}
			rules, err := safeIgnoredRules(flags)
			if err != nil {
				return usageError(cmd, err)
			}
			report, err := engine.FilesWithRules(ctx, host, args[0], repository, limit, rules, removalProgress(cmd.ErrOrStderr(), progress, false))
			if err != nil {
				return err
			}
			if asJSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(report)
			}
			return printFiles(cmd.OutOrStdout(), report)
		},
	}
	addSafeIgnoredFlags(cmd, flags)
	cmd.Flags().StringVar(&repository, "repo", "", "The repository it belongs to: its folder, or its .git folder (needed when the worktree's own folder is gone)")
	cmd.Flags().StringVar(&host, "host", "", "SSH host alias or user@hostname")
	cmd.Flags().IntVar(&limit, "limit", 200, "How many to list under each heading (1–10000)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Write machine-readable results to stdout")
	cmd.Flags().BoolVar(&progress, "progress", false, "Write framed JSON progress to stderr")
	cmd.Flags().BoolVar(&watchStdin, "watch-stdin", false, "Cancel when the SSH input channel closes")
	_ = cmd.Flags().MarkHidden("watch-stdin")
	return cmd
}

var fileHeadings = map[string]string{
	"changes":    "Uncommitted changes",
	"ignored":    "Ignored files",
	"unchecked":  "Unchecked files",
	"submodules": "Submodules",
	"operation":  "Unfinished Git operation",
	"nested":     "Nested repository",
	"refs":       "Refs of its own",
}

func printFiles(out io.Writer, report worktree.FilesReport) error {
	var text strings.Builder
	fmt.Fprintf(&text, "What %s holds\nDeleting this worktree permanently discards the items below. Nothing is moved to Trash.\n", printable(report.Path))
	for _, kind := range worktree.FileKinds {
		if report.Counts[kind] == 0 {
			continue
		}
		fmt.Fprintf(&text, "\n%s (%d)\n", fileHeadings[kind], report.Counts[kind])
		shown := 0
		for _, entry := range report.Entries {
			if entry.Kind != kind {
				continue
			}
			shown++
			prefix := ""
			if entry.SizeLowerBound {
				prefix = "at least "
			}
			detail := ""
			if entry.Status != "" {
				detail = " · " + entry.Status
			}
			if entry.Kind == "ignored" {
				if entry.SafeIgnored {
					detail += " · Marked safe (" + printable(entry.SafeIgnoredRule) + ")"
				} else {
					detail += " · Not marked safe"
				}
			}
			if entry.Directory {
				detail += fmt.Sprintf(" · %s%d files", prefix, entry.Files)
			}
			fmt.Fprintf(&text, "  %s  %s%s%s\n", printable(entry.Path), prefix, byteSize(entry.SizeBytes), detail)
		}
		if more := report.Counts[kind] - shown; more > 0 {
			fmt.Fprintf(&text, "  and %d more\n", more)
		}
	}
	for _, warning := range report.Warnings {
		fmt.Fprintf(&text, "\n%s\n", printable(warning))
	}
	// No total: a folder can be listed under more than one heading, and its
	// size with it.
	fmt.Fprintln(&text, "\nThe same folder can be under more than one heading. Sizes are of files on disk, not of commits or of space recovered.")
	_, err := io.WriteString(out, text.String())
	return err
}
