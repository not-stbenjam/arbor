package main

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"
	"github.com/stbenjam/arbor/internal/engine"
	"github.com/stbenjam/arbor/internal/worktree"
)

type commonFlags struct {
	root, host          string
	github, fetch, json bool
}

func (c commonFlags) options() worktree.Options {
	return worktree.Options{Root: c.root, GitHub: c.github, Fetch: c.fetch}
}

type commandOptions struct {
	common                                                        commonFlags
	yes, recommended, progress, all, quiet                        bool
	linkedOnly, noDefaultExcludes, discardLocal, keepLocal, force bool
	acknowledge                                                   []string
	targetOnly, watchStdin                                        bool
	expectMissing, expectEmpty, expectBranch                      bool
	excludes                                                      []string
	head, id, branch, repository, statsSession                    string
}

func newRootCommand(stdout, stderr io.Writer) *cobra.Command {
	root := &cobra.Command{
		Use:           "arbor",
		Short:         "Find Git worktrees. Delete the ones you no longer need.",
		Long:          "Arbor finds linked Git worktrees locally or over SSH and helps you remove them.\nOrdinary repository checkouts are not cleanup items. Run a command below;\nuse 'arbor gui' to open the desktop app.",
		Example:       "  arbor list --path ~/code\n  arbor clean --path ~/code\n  arbor remove /path/to/worktree --yes\n  arbor list --host my-vps --path ~/projects\n  arbor gui",
		Version:       version,
		SilenceErrors: true,
		SilenceUsage:  true,
	}
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetVersionTemplate("arbor {{.Version}}\n")
	root.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error { return usageError(cmd, err) })
	root.AddCommand(newListCommand(), newCleanCommand(), newRemoveCommand(), newGUICommand(), newStatsCommand())
	root.AddCommand(&cobra.Command{
		Use: "version", Short: "Print the Arbor version", Args: checkedArgs(cobra.NoArgs),
		RunE: func(cmd *cobra.Command, _ []string) error {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), "arbor", version)
			return err
		},
	})
	return root
}

func usageError(cmd *cobra.Command, err error) error {
	return fmt.Errorf("%w\nRun '%s --help' for usage", err, cmd.CommandPath())
}

func checkedArgs(validate cobra.PositionalArgs) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := validate(cmd, args); err != nil {
			return usageError(cmd, err)
		}
		return nil
	}
}

func addConnectionFlags(cmd *cobra.Command, flags *commandOptions, withPath bool) {
	f := cmd.Flags()
	if withPath {
		f.StringVarP(&flags.common.root, "path", "p", "", "Folder to scan (default: home directory on the target host)")
		_ = cmd.MarkFlagDirname("path")
	}
	f.StringVar(&flags.common.host, "host", "", "SSH host alias or user@hostname")
	f.BoolVar(&flags.common.github, "github", false, "Also ask GitHub which pull requests were merged, using gh credentials on the target host")
	f.BoolVar(&flags.common.fetch, "fetch", false, "Fetch remote refs before inspection (uses the network)")
}

func addOutputFlags(cmd *cobra.Command, flags *commandOptions) {
	f := cmd.Flags()
	f.BoolVar(&flags.common.json, "json", false, "Write machine-readable results to stdout")
	f.BoolVar(&flags.progress, "progress", false, "Stream framed JSON progress to stderr (for integrations)")
	f.BoolVarP(&flags.quiet, "quiet", "q", false, "Hide human progress messages; keep results and errors")
}

func addDiscoveryFlags(cmd *cobra.Command, flags *commandOptions) {
	f := cmd.Flags()
	f.StringArrayVar(&flags.excludes, "exclude", nil, "Skip a directory name, path, or glob (repeatable; quote patterns)")
	f.BoolVar(&flags.noDefaultExcludes, "no-default-excludes", false, "Do not use the default cache/temp exclusions")
}

func worktreeCommand(use, short, long, example string, flags *commandOptions) *cobra.Command {
	return &cobra.Command{
		Use: use, Short: short, Long: long, Example: example,
		Args: checkedArgs(cobra.NoArgs),
		RunE: func(cmd *cobra.Command, args []string) error {
			if cmd.Name() == "remove" {
				flags.common.root = args[0]
				// An empty branch is itself an expectation: the checkout was detached.
				flags.expectBranch = cmd.Flags().Changed("branch")
			}
			return runWorktrees(cmd.Context(), cmd.Name(), flags, cmd.OutOrStdout(), cmd.ErrOrStderr())
		},
	}
}

func newListCommand() *cobra.Command {
	flags := &commandOptions{linkedOnly: true}
	cmd := worktreeCommand("list", "Find and inspect linked worktrees",
		"Find linked worktrees under a folder, with paths, branches, activity, and status.\nPrimary checkouts are omitted. Use --linked-only=false to include them for\ndiagnostics. Fetch and GitHub checks are opt-in. JSON stdout remains clean;\nhuman progress and --progress events go to stderr.",
		"  arbor list -p ~/code\n  arbor list --host my-vps --json\n  arbor list --exclude '~/.codex*/.tmp'\n  arbor list --recommended --fetch --github", flags)
	addConnectionFlags(cmd, flags, true)
	addOutputFlags(cmd, flags)
	addDiscoveryFlags(cmd, flags)
	f := cmd.Flags()
	f.BoolVar(&flags.linkedOnly, "linked-only", true, "Show only linked worktrees; use --linked-only=false for all registrations")
	f.BoolVar(&flags.recommended, "recommended", false, "Show only clean, merged cleanup recommendations")
	f.BoolVar(&flags.targetOnly, "target-only", false, "Inspect only the exact registered worktree path")
	f.BoolVar(&flags.watchStdin, "watch-stdin", false, "Cancel when the SSH input channel closes")
	f.StringVar(&flags.repository, "repo", "", "Repository owning the target registration")
	for _, name := range []string{"target-only", "watch-stdin", "repo"} {
		_ = f.MarkHidden(name)
	}
	return cmd
}

func newCleanCommand() *cobra.Command {
	flags := &commandOptions{linkedOnly: true}
	cmd := worktreeCommand("clean", "Preview or delete worktrees beneath a folder",
		"Preview clean, merged worktrees that can be removed. Nothing is deleted until\n--yes is supplied. --all also takes clean worktrees that are not merged; their\nbranches keep the commits. Worktrees that are not a clean delete are skipped\nunless --force is added. --force agrees to everything the preview lists for\nthem: local files, and where it says so a submodule's unpushed commits, an\nunfinished rebase or merge, or another repository inside the folder.\nEach worktree's own branches and commits are kept; nothing is sent to Trash.",
		"  arbor clean -p ~/code\n  arbor clean -p ~/code --yes\n  arbor clean -p ~/old-sessions --all --yes\n  arbor clean -p ~/old-sessions --all --force --yes\n  arbor clean --host my-vps --path ~/projects --json", flags)
	addConnectionFlags(cmd, flags, true)
	addOutputFlags(cmd, flags)
	addDiscoveryFlags(cmd, flags)
	cmd.Flags().BoolVarP(&flags.yes, "yes", "y", false, "Perform removal instead of previewing")
	cmd.Flags().BoolVar(&flags.all, "all", false, "Include clean worktrees that are not merged")
	cmd.Flags().BoolVarP(&flags.force, "force", "f", false, "With --all, also take worktrees that are not a clean delete, discarding what the preview lists")
	return cmd
}

func newRemoveCommand() *cobra.Command {
	flags := &commandOptions{linkedOnly: true}
	cmd := worktreeCommand("remove PATH", "Preview or delete one linked worktree",
		"Preview removal of one linked checkout. Pass --yes to delete it. Like\n'git worktree remove', that alone is refused when the checkout has uncommitted,\nuntracked or ignored files, or is locked; the preview says which. Add --force\nto discard those files and override the lock. --force agrees to everything\nthe preview lists, which can include a submodule's unpushed commits, an\nunfinished rebase or merge, or another repository inside the folder. It is\nalso what removes a detached, missing or empty checkout.\nThe worktree's own branches are kept. Detached commits get a recovery branch only when no\nbranch already holds them. A missing checkout removes only its Git\nregistration; provide --repo when its owning repository cannot be found from\nthe path. Flags may follow PATH. Use -- before a path beginning with a dash.",
		"  arbor remove /path/to/worktree\n  arbor remove /path/to/worktree --yes\n  arbor remove /path/to/worktree --force --yes\n  arbor remove /missing/worktree --repo ~/code/project --force --yes\n  arbor remove --yes -- ./-old-session", flags)
	cmd.Args = checkedArgs(cobra.ExactArgs(1))
	cmd.ValidArgsFunction = cobra.FixedCompletions(nil, cobra.ShellCompDirectiveFilterDirs)
	addConnectionFlags(cmd, flags, false)
	addOutputFlags(cmd, flags)
	f := cmd.Flags()
	f.BoolVarP(&flags.yes, "yes", "y", false, "Perform removal instead of previewing")
	f.BoolVar(&flags.keepLocal, "keep-local", false, "Refuse removal if local files would be discarded (the default)")
	f.BoolVarP(&flags.force, "force", "f", false, "Discard whatever the preview lists, and override a lock; needed for anything that is not a clean delete")
	f.StringVar(&flags.repository, "repo", "", "Owning repository or Git common directory (for missing checkouts)")
	_ = cmd.MarkFlagDirname("repo")
	f.StringVar(&flags.head, "head", "", "Require this exact commit before removal")
	f.BoolVar(&flags.recommended, "recommended-only", false, "Require a fresh clean, merged cleanup recommendation")
	f.BoolVar(&flags.discardLocal, "discard-local", false, "Discard local files and override a lock (for integrations; see --acknowledge)")
	f.StringArrayVar(&flags.acknowledge, "acknowledge", nil, "With --discard-local, also accept this loss: submodules, operation or nested. Repeatable (for integrations)")
	f.StringVar(&flags.id, "id", "", "Require this worktree identity")
	f.StringVar(&flags.branch, "branch", "", "Require this branch (empty requires a detached HEAD)")
	f.StringVar(&flags.statsSession, "stats-session", "", "Group removal statistics into a cleanup session")
	f.BoolVar(&flags.expectMissing, "expect-missing", false, "Require the confirmed checkout to remain missing")
	f.BoolVar(&flags.expectEmpty, "expect-empty", false, "Require the confirmed checkout to remain empty or missing")
	for _, name := range []string{"keep-local", "discard-local", "acknowledge", "id", "branch", "stats-session", "expect-missing", "expect-empty"} {
		_ = f.MarkHidden(name)
	}
	return cmd
}

func newGUICommand() *cobra.Command {
	flags := &commandOptions{}
	cmd := &cobra.Command{
		Use: "gui", Short: "Open the installed Arbor desktop app",
		Long:    "Launch the separately installed Arbor desktop app. All other commands run\nindependently of the desktop app. Running bare 'arbor' prints CLI help.",
		Example: "  arbor gui\n  arbor gui --path ~/code\n  arbor gui --host my-vps",
		Args:    checkedArgs(cobra.NoArgs),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := engine.ValidateHost(flags.common.host); err != nil {
				return err
			}
			if err := launchDesktop(flags.common); err != nil {
				return err
			}
			_, err := fmt.Fprintln(cmd.OutOrStdout(), "Launched Arbor desktop.")
			return err
		},
	}
	addConnectionFlags(cmd, flags, true)
	return cmd
}
