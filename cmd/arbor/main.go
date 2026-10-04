package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/not-stbenjam/arbor/internal/engine"
	"github.com/not-stbenjam/arbor/internal/worktree"
)

var version = "dev"

const help = `Arbor — a little room for your next idea.

Usage:
  arbor                            Open the native desktop app
  arbor gui [options]              Open the native desktop app
  arbor list [options]             Discover and inspect worktrees
  arbor clean [options]            Preview recommended removals
  arbor remove [options] PATH      Preview removing one worktree
  arbor version                    Print the version

Shared options:
  --path PATH       Scan folder (default: home directory)
  --host HOST       SSH host alias or user@hostname
  --github          Verify pull requests using GitHub CLI credentials
  --fetch           Fetch remote refs before inspection (network access)

List options:
  --json            Machine-readable report
  --progress        Stream scan progress as prefixed JSON lines on stderr
  --exclude GLOB    Skip a directory name, path, or glob (repeatable; quote patterns)
  --no-default-excludes  Scan without the default cache/temp exclusions
  --recommended     Only show cleanup recommendations
  --linked-only     Only linked worktrees (default: true)

Cleanup options:
  --yes             Perform removal (otherwise preview only)
  --json            Machine-readable result
  --all             With clean: include unmerged worktrees and local files

Remove options:
  --head COMMIT     Require this exact commit
  --recommended-only  Require a fresh cleanup recommendation
  --discard-local  Explicitly delete local files in a linked worktree (requires --yes)

Examples:
  arbor list --path ~/code
  arbor list --host my-vps --json
  arbor clean --path ~/code --github --yes
  arbor remove --yes -- ../finished-feature

Branches are retained. "remove" deletes the selected linked checkout and its
local files; preview first, then pass --yes. "clean" defaults to merged, clean
worktrees; --all includes other linked checkouts. Primary repositories are never
removed. Detached commits are retained on an arbor/retained/ recovery branch.
`

type commonFlags struct {
	root, host          string
	github, fetch, json bool
}

func addCommon(f *flag.FlagSet, c *commonFlags) {
	f.StringVar(&c.root, "path", "", "scan folder (default: home directory)")
	f.StringVar(&c.host, "host", "", "SSH host alias or user@hostname")
	f.BoolVar(&c.github, "github", false, "verify GitHub pull requests")
	f.BoolVar(&c.fetch, "fetch", false, "fetch remote refs before scanning")
	f.BoolVar(&c.json, "json", false, "JSON output")
}

func (c commonFlags) options() worktree.Options {
	return worktree.Options{Root: c.root, GitHub: c.github, Fetch: c.fetch}
}

func main() {
	// Finder apps do not inherit interactive shell startup files.
	if runtime.GOOS == "darwin" {
		_ = os.Setenv("PATH", os.Getenv("PATH")+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
	}
	engine.Version = version
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	if err := execute(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "arbor:", err)
		os.Exit(1)
	}
}

func execute(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	command := "gui"
	if len(args) > 0 {
		if !strings.HasPrefix(args[0], "-") || args[0] == "--help" || args[0] == "-h" || args[0] == "--version" {
			command, args = args[0], args[1:]
		}
	}
	if command == "help" || command == "--help" || command == "-h" {
		_, err := io.WriteString(stdout, help)
		return err
	}
	if command == "version" || command == "--version" {
		_, err := fmt.Fprintln(stdout, "arbor", version)
		return err
	}
	if command != "gui" && command != "list" && command != "clean" && command != "remove" {
		return fmt.Errorf("unknown command %q; run arbor help", command)
	}
	f := flag.NewFlagSet(command, flag.ContinueOnError)
	f.SetOutput(stderr)
	var common commonFlags
	addCommon(f, &common)
	var yes, recommended, progress, all bool
	linkedOnly := true
	var noDefaultExcludes bool
	var discardLocal bool
	var keepLocal bool
	var targetOnly bool
	var watchStdin bool
	var excludes stringListFlag
	var head, id, branch string
	if command == "list" {
		f.BoolVar(&targetOnly, "target-only", false, "internal: inspect only the exact registered worktree path")
		f.BoolVar(&linkedOnly, "linked-only", true, "only linked worktrees, excluding primary repository checkouts")
		f.BoolVar(&recommended, "recommended", false, "only cleanup recommendations")
		f.BoolVar(&progress, "progress", false, "stream scan progress on stderr")
		f.BoolVar(&noDefaultExcludes, "no-default-excludes", false, "disable default cache/temp exclusions")
		f.Var(&excludes, "exclude", "directory name, path, or glob to skip (repeatable; extends defaults)")
		f.BoolVar(&watchStdin, "watch-stdin", false, "internal: cancel when the SSH input channel closes")
	}
	if command == "clean" || command == "remove" {
		f.BoolVar(&yes, "yes", false, "perform removal instead of preview")
	}
	if command == "clean" {
		f.BoolVar(&all, "all", false, "include unmerged linked worktrees and discard local files (preview unless --yes)")
	}
	if command == "remove" {
		f.BoolVar(&keepLocal, "keep-local", false, "refuse removal if local files would be discarded")
		f.BoolVar(&discardLocal, "discard-local", false, "allow deleting local files and overriding a worktree lock; detached commits are retained")
		f.StringVar(&head, "head", "", "expected commit")
		f.StringVar(&id, "id", "", "expected worktree identity")
		f.StringVar(&branch, "branch", "", "expected branch")
		f.BoolVar(&recommended, "recommended-only", false, "require a cleanup recommendation")
	}
	if err := f.Parse(args); err != nil {
		return err
	}
	if discardLocal && recommended {
		return errors.New("--discard-local cannot be combined with --recommended-only")
	}
	if discardLocal && keepLocal {
		return errors.New("--discard-local and --keep-local are mutually exclusive")
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
	if command != "remove" && f.NArg() != 0 {
		return errors.New("unexpected positional arguments; use --path to choose a scan folder")
	}
	if command == "gui" {
		return launchDesktop(common)
	}
	if command == "remove" {
		if f.NArg() != 1 {
			return errors.New("provide exactly one worktree path after the options")
		}
		common.root = f.Arg(0)
	}
	options := common.options()
	options.LinkedOnly = linkedOnly
	options.TargetOnly = command == "remove" || targetOnly
	if noDefaultExcludes || len(excludes) > 0 {
		options.Excludes = []string{}
		if !noDefaultExcludes {
			options.Excludes = append(options.Excludes, worktree.DefaultExcludes()...)
		}
		options.Excludes = append(options.Excludes, excludes...)
	}
	if progress {
		options.Progress = func(event worktree.Progress) {
			if data, err := json.Marshal(event); err == nil {
				fmt.Fprintf(stderr, "%s%s\n", worktree.ProgressPrefix, data)
			}
		}
	}
	report, err := engine.Scan(ctx, common.host, options)
	if err != nil {
		return err
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
		printTable(stdout, report.Worktrees)
		for _, warning := range report.Warnings {
			fmt.Fprintln(stderr, "Warning:", warning)
		}
		return nil
	}
	var selected []worktree.Worktree
	if command == "clean" {
		for _, w := range report.Worktrees {
			if w.Recommended || (all && (w.CanRemove || w.CanDiscard)) {
				selected = append(selected, w)
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
			return errors.New("path is not a linked worktree")
		}
		w := selected[0]
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
		printTable(stdout, selected)
		if discardLocal {
			for _, w := range selected {
				for _, warning := range w.DiscardWarnings {
					fmt.Fprintln(stdout, warning)
				}
			}
		}
		fmt.Fprintf(stdout, "\nPreview only. %d worktree(s) eligible. Pass --yes to remove; branches are retained.\n", len(selected))
		return nil
	}
	results := []worktree.RemovalResult{}
	failed := false
	for _, w := range selected {
		result := worktree.RemovalResult{Path: w.Path}
		if err := engine.RemoveWithOptions(ctx, common.host, w, w.Head, (command == "clean" && !all) || recommended, discardLocal); err != nil {
			result.Error = err.Error()
			failed = true
		} else {
			result.Removed = true
		}
		results = append(results, result)
		if !common.json {
			if result.Removed {
				fmt.Fprintln(stdout, "Removed", w.Path, "(branch retained)")
			} else {
				fmt.Fprintln(stderr, w.Path+":", result.Error)
			}
		}
	}
	if common.json {
		var value any = results
		if command == "remove" {
			value = results[0]
		}
		if err := json.NewEncoder(stdout).Encode(value); err != nil {
			return err
		}
	}
	if failed {
		return errors.New("some worktrees could not be removed")
	}
	return nil
}

type stringListFlag []string

func (values *stringListFlag) String() string { return strings.Join(*values, ", ") }
func (values *stringListFlag) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func printTable(out io.Writer, entries []worktree.Worktree) {
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
	_ = w.Flush()
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
