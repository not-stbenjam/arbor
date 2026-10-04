package worktree

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

func Scan(ctx context.Context, options Options) (Report, error) {
	start := time.Now()
	root, err := ResolveRoot(options.Root)
	if err != nil && options.TargetOnly && os.IsNotExist(err) {
		root, err = resolveMissingRoot(options.Root)
	}
	if err != nil {
		return Report{}, err
	}
	st, err := os.Stat(root)
	missingTarget := options.TargetOnly && os.IsNotExist(err)
	if err != nil && !missingTarget {
		return Report{}, err
	}
	if st != nil && !st.IsDir() {
		return Report{}, errors.New("scan root must be a directory")
	}
	excluded, err := compileExcludes(root, options.Excludes)
	if err != nil {
		return Report{}, err
	}
	lookupRoot := root
	if options.TargetOnly && (missingTarget || options.Repository != "") {
		lookupRoot, err = repositoryForTarget(ctx, root, options.Repository)
		if err != nil {
			return Report{}, err
		}
	}
	gitVersion, err := git(ctx, lookupRoot, "--version")
	if err != nil {
		return Report{}, fmt.Errorf("Git is required: %w", err)
	}
	var major, minor int
	if _, err := fmt.Sscanf(gitVersion, "git version %d.%d", &major, &minor); err != nil || major < 2 || (major == 2 && minor < 36) {
		return Report{}, fmt.Errorf("Git 2.36 or newer is required (found %s)", strings.TrimSpace(gitVersion))
	}
	report := Report{Root: root, ScannedAt: start, Worktrees: []Worktree{}, Warnings: []string{}, GitHub: options.GitHub, Fetched: options.Fetch}
	paths := []string{lookupRoot}
	var warnings []string
	if !options.TargetOnly {
		progress := options.Progress
		if options.LinkedOnly && progress != nil {
			progress = func(event Progress) {
				// A .git marker alone cannot classify the checkout as linked.
				// Wait for Git's registered worktree list before showing rows.
				event.Worktree = nil
				options.Progress(event)
			}
		}
		paths, warnings, err = discover(ctx, root, excluded, progress)
	}
	if err != nil {
		return report, err
	}
	report.Warnings = append(report.Warnings, warnings...)
	seen := map[string]bool{}
	registeredPaths := map[string]bool{}
	notify := func(stage, path string, completed, total int) {
		if options.Progress != nil {
			options.Progress(Progress{Stage: stage, Path: path, Discovered: len(paths), Completed: completed, Total: total})
		}
	}
	for _, path := range paths {
		if ctx.Err() != nil {
			return report, ctx.Err()
		}
		if registeredPaths[path] {
			continue
		}
		common, explicitGitDir := resolveCommonDirectory(ctx, path)
		if common == "" {
			report.Warnings = append(report.Warnings, "Could not inspect repository: "+path)
			continue
		}
		if resolved, err := filepath.EvalSymlinks(common); err == nil {
			common = resolved
		}
		if seen[common] {
			continue
		}
		seen[common] = true
		if options.Fetch {
			notify("fetch", path, len(seen)-1, 0)
			// Fetch only on explicit request; never prune or change a local branch.
			args := []string{"-c", "core.hooksPath=/dev/null", "-C", path}
			if explicitGitDir != "" {
				args = append(args, "--bare", "--git-dir="+explicitGitDir)
			}
			args = append(args, "fetch", "--all", "--no-recurse-submodules")
			_, err := run(ctx, 2*time.Minute, "git", args...)
			if err != nil {
				report.Fetched = false
				report.Warnings = append(report.Warnings, "Fetch failed for "+path+": "+err.Error())
			}
		}
		listArgs := []string{"worktree", "list", "--porcelain", "-z"}
		if explicitGitDir != "" {
			listArgs = append([]string{"--bare"}, listArgs...)
		}
		raw, err := gitCommon(ctx, common, listArgs...)
		if err != nil {
			report.Warnings = append(report.Warnings, err.Error())
			continue
		}
		entries := parseList(raw)
		for i := range entries {
			w := &entries[i]
			registeredPaths[w.Path] = true
			w.Main = i == 0
			w.OutsideRoot = !within(root, w.Path)
			if (options.TargetOnly && w.Path != root) || (options.LinkedOnly && (w.Main || w.Bare || w.OutsideRoot)) {
				continue
			}
			if excluded(w.Path) {
				continue
			}
			w.CommonDir = common
			w.Repo = filepath.Base(filepath.Dir(common))
			if w.Main && w.Bare {
				w.Repo = strings.TrimSuffix(filepath.Base(common), ".git")
			}
			if len(entries) > 0 && entries[0].Bare {
				w.Repo = strings.TrimSuffix(filepath.Base(common), ".git")
			}
			sum := sha256.Sum256([]byte(common + "\x00" + w.Path))
			w.ID = hex.EncodeToString(sum[:12])
			report.Worktrees = append(report.Worktrees, *w)
			if options.Progress != nil {
				// Registration entries are not modified by inspection workers.
				options.Progress(Progress{Stage: "discovery", Path: w.Path, Discovered: len(paths), Worktree: w, Pending: true})
			}
		}
	}
	// Git worktrees are independent. Keep I/O bounded for large home directories.
	jobs := make(chan int)
	var wg sync.WaitGroup
	var progressMu sync.Mutex
	completed := 0
	defaults := map[string]*repositoryDefault{}
	for _, w := range report.Worktrees {
		if defaults[w.CommonDir] == nil {
			defaults[w.CommonDir] = &repositoryDefault{}
		}
	}
	notify("inspect", root, 0, len(report.Worktrees))
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				if ctx.Err() != nil {
					return
				}
				progressMu.Lock()
				notify("inspect", report.Worktrees[index].Path, completed, len(report.Worktrees))
				progressMu.Unlock()
				inspectWithDefault(ctx, &report.Worktrees[index], options, defaults[report.Worktrees[index].CommonDir])
				if ctx.Err() != nil {
					return
				}
				progressMu.Lock()
				completed++
				if options.Progress != nil {
					w := report.Worktrees[index]
					options.Progress(Progress{Stage: "inspect", Path: w.Path, Discovered: len(paths), Completed: completed, Total: len(report.Worktrees), Worktree: &w})
				}
				progressMu.Unlock()
			}
		}()
	}
dispatch:
	for i := range report.Worktrees {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break dispatch
		}
	}
	close(jobs)
	wg.Wait()
	if ctx.Err() != nil {
		return report, ctx.Err()
	}
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
