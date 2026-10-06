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
	var host, repository string
	var limit int
	var asJSON, watchStdin bool
	cmd := &cobra.Command{
		Use: "files PATH", Short: "Show what deleting one linked worktree would discard",
		Long:    "List local files and worktree metadata that deleting a linked worktree would\ndiscard. Nothing is changed. Counts and bytes include entries beyond --limit.\nSizes are lower bounds when the three-second measurement budget runs out.\nCategories can overlap; their sum is not space recovered.",
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
			report, err := engine.Files(ctx, host, args[0], repository, limit)
			if err != nil {
				return err
			}
			if asJSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(report)
			}
			return printFiles(cmd.OutOrStdout(), report)
		},
	}
	cmd.Flags().StringVar(&repository, "repo", "", "Owning repository or Git common directory (for missing checkouts)")
	cmd.Flags().StringVar(&host, "host", "", "SSH host alias or user@hostname")
	cmd.Flags().IntVar(&limit, "limit", 200, "Maximum entries shown per kind (1–10000)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Write machine-readable results")
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
	var count int
	var bytes int64
	for _, kind := range worktree.FileKinds {
		count += report.Counts[kind]
		bytes += report.Bytes[kind]
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
	prefix := ""
	if report.SizeLowerBound {
		prefix = "at least "
	}
	fmt.Fprintln(&text, "\nCategories can overlap. Sizes count files on disk, not commits or space recovered.")
	fmt.Fprintf(&text, "Total: %d entries · %s%s\n", count, prefix, byteSize(bytes))
	_, err := io.WriteString(out, text.String())
	return err
}
