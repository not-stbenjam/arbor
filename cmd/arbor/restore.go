package main

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/stbenjam/arbor/internal/engine"
	"github.com/stbenjam/arbor/internal/worktree"
)

func newRestoreCommand() *cobra.Command {
	var options worktree.RestoreOptions
	var host string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "restore PATH --repo COMMON_DIR (--branch BRANCH | --detach COMMIT)",
		Short: "Put a deleted worktree back",
		Long:  "Put a deleted worktree back on its branch, or at a detached commit.\nThe destination must not exist and its parent folder must exist. Branches\nare restored as they are now; --head reports whether a branch has moved.\nHooks are switched off. Repository filter programs are refused; standard\nGit LFS is allowed. Discarded uncommitted files cannot be restored.",
		Args:  checkedArgs(cobra.ExactArgs(1)),
		RunE: func(cmd *cobra.Command, args []string) error {
			options.Path = args[0]
			if err := worktree.ValidateRestore(options); err != nil {
				return usageError(cmd, err)
			}
			if err := engine.ValidateHost(host); err != nil {
				return usageError(cmd, err)
			}
			result, err := engine.Restore(cmd.Context(), host, options)
			if asJSON {
				if e := json.NewEncoder(cmd.OutOrStdout()).Encode(result); e != nil {
					return e
				}
			} else if result.Restored {
				label := result.Branch
				if label == "" {
					label = "detached at " + result.Head
				}
				fmt.Fprintf(cmd.OutOrStdout(), "Put back %s (%s).\n", printable(result.Path), printable(label))
				if result.Moved {
					fmt.Fprintln(cmd.OutOrStdout(), "The branch has moved since deletion; restored its current commit.")
				}
			}
			return err
		},
	}
	f := cmd.Flags()
	f.StringVar(&options.CommonDir, "repo", "", "Owning Git common directory")
	f.StringVar(&options.Branch, "branch", "", "Existing branch to check out")
	f.StringVar(&options.Detach, "detach", "", "Full commit ID to check out detached")
	f.StringVar(&options.Head, "head", "", "Previous commit ID, to report a moved branch")
	f.StringVar(&host, "host", "", "SSH host alias or user@hostname")
	f.BoolVar(&asJSON, "json", false, "Print the result as JSON")
	return cmd
}
