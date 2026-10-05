package worktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Scan coordinates discovery, registered-worktree collection, and bounded
// inspection. Each stage owns its work; only this coordinator finalizes a report.
func Scan(ctx context.Context, options Options) (Report, error) {
	start := time.Now()
	location, err := prepareScan(ctx, options)
	if err != nil {
		return Report{}, err
	}
	report := Report{Root: location.root, ScannedAt: start, Worktrees: []Worktree{}, Warnings: []string{}, GitHub: options.GitHub, Fetched: options.Fetch}
	paths, warnings, err := discoverScan(ctx, location, options)
	if err != nil {
		return report, err
	}
	report.Warnings = append(report.Warnings, warnings...)
	defaults, err := collectRegistrations(ctx, &report, paths, location.excluded, options)
	if err != nil {
		return report, err
	}
	if err := inspectWorktrees(ctx, &report, options, len(paths), defaults); err != nil {
		return report, err
	}
	report.Warnings = append(report.Warnings, defaultWarnings(defaults)...)
	sort.Slice(report.Worktrees, func(i, j int) bool {
		a, b := report.Worktrees[i], report.Worktrees[j]
		if a.Repo != b.Repo {
			return a.Repo < b.Repo
		}
		if a.Main != b.Main {
			return a.Main
		}
		return a.Path < b.Path
	})
	report.DurationMS = time.Since(start).Milliseconds()
	return report, nil
}

// defaultWarnings explains, once per repository, why none of its worktrees
// could be recognized as merged. Without it the list would only be quieter.
func defaultWarnings(defaults map[string]*repositoryDefault) []string {
	var warnings []string
	for _, repository := range defaults {
		if repository.problem != "" {
			warnings = append(warnings, "Nothing is recommended in "+repository.repository+": "+repository.problem+".")
		}
	}
	sort.Strings(warnings)
	return warnings
}

type scanLocation struct {
	root, lookupRoot string
	excluded         func(string) bool
}

// prepareScan resolves an explicitly targeted missing registration without
// widening discovery, validates exclusions, and checks the supported Git version.
func prepareScan(ctx context.Context, options Options) (scanLocation, error) {
	root, err := ResolveRoot(options.Root)
	if err != nil && options.TargetOnly && os.IsNotExist(err) {
		root, err = resolveMissingRoot(options.Root)
	}
	if os.IsNotExist(err) {
		return scanLocation{}, fmt.Errorf("folder does not exist: %s", options.Root)
	}
	if err != nil {
		return scanLocation{}, err
	}
	st, err := os.Stat(root)
	missingTarget := options.TargetOnly && os.IsNotExist(err)
	if err != nil && !missingTarget {
		return scanLocation{}, err
	}
	if st != nil && !st.IsDir() {
		return scanLocation{}, errors.New("scan root must be a directory")
	}
	excluded, err := compileExcludes(root, options.Excludes)
	if err != nil {
		return scanLocation{}, err
	}
	lookupRoot := root
	if options.TargetOnly && (missingTarget || options.Repository != "") {
		lookupRoot, err = repositoryForTarget(ctx, root, options.Repository)
		if err != nil {
			return scanLocation{}, err
		}
	}
	gitVersion, err := git(ctx, lookupRoot, "--version")
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return scanLocation{}, errors.New("Git was not found on PATH. Install Git 2.36 or newer on the machine being scanned and make it available on PATH")
		}
		return scanLocation{}, fmt.Errorf("could not run Git in %s; check that the folder is accessible and Git works there: %w", root, err)
	}
	var major, minor int
	if _, err := fmt.Sscanf(gitVersion, "git version %d.%d", &major, &minor); err != nil || major < 2 || (major == 2 && minor < 36) {
		return scanLocation{}, fmt.Errorf("Git 2.36 or newer is required (found %s)", strings.TrimSpace(gitVersion))
	}
	return scanLocation{root: root, lookupRoot: lookupRoot, excluded: excluded}, nil
}

func discoverScan(ctx context.Context, location scanLocation, options Options) ([]string, []string, error) {
	if options.TargetOnly {
		return []string{location.lookupRoot}, nil, nil
	}
	progress := options.Progress
	if options.LinkedOnly && progress != nil {
		progress = func(event Progress) {
			// A .git marker alone cannot classify the checkout as linked.
			// Wait for Git's registered worktree list before showing rows.
			event.Worktree = nil
			options.Progress(event)
		}
	}
	return discover(ctx, location.root, location.excluded, progress)
}
