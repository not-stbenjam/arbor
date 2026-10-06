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
		Use:   "restore PATH --repo REPOSITORY (--branch BRANCH | --detach COMMIT)",
		Short: "Put a deleted worktree back",
		Long: "Put a deleted worktree back where it was: on its branch, or at a commit\n" +
			"with --detach. Deleting a worktree keeps its branch, so its commits are\n" +
			"all still there. Files that were never committed are not, and do not come\n" +
			"back.\n\n" +
			"Nothing is overwritten: PATH must not exist, and the folder it is in must.\n" +
			"The branch is checked out as it is now; with --head, the result says\n" +
			"whether it has moved since. Git hooks are not run and nothing is fetched.\n" +
			"A repository that names its own filter programs is not restored, nor is a\n" +
			"worktree of a partial clone whose files are not all there already: the Git\n" +
			"command to run yourself is given instead. Standard Git LFS is allowed.\n\n" +
			"remove and clean print the command that puts back what they deleted.",
		Args: checkedArgs(cobra.ExactArgs(1)),
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
					fmt.Fprintln(cmd.OutOrStdout(), "Its branch has moved since it was deleted; it is at the branch's current commit.")
				}
			}
			return err
		},
	}
	f := cmd.Flags()
	f.StringVar(&options.CommonDir, "repo", "", "The repository it belonged to: its folder, or its .git folder")
	f.StringVar(&options.Branch, "branch", "", "The branch it was on")
	f.StringVar(&options.Detach, "detach", "", "The full commit ID a detached worktree was at")
	f.StringVar(&options.Head, "head", "", "The full commit ID it was at when deleted, to be told if the branch has moved")
	f.StringVar(&host, "host", "", "SSH host alias or user@hostname")
	f.BoolVar(&asJSON, "json", false, "Print the result as JSON")
	return cmd
}
