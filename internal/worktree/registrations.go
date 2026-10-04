package worktree

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
	"time"
)

// collectRegistrations visits each common repository once and materializes
// linked registrations before inspection. Discovery markers are not authority
// to identify a checkout or to offer it for removal.
func collectRegistrations(ctx context.Context, report *Report, paths []string, excluded func(string) bool, options Options) error {
	seen := map[string]bool{}
	registeredPaths := map[string]bool{}
	for _, path := range paths {
		if ctx.Err() != nil {
			return ctx.Err()
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
			if options.Progress != nil {
				options.Progress(Progress{Stage: "fetch", Path: path, Discovered: len(paths), Completed: len(seen) - 1})
			}
			if err := fetchRepository(ctx, path); err != nil {
				report.Fetched = false
				report.Warnings = append(report.Warnings, "Fetch failed for "+path+": "+err.Error())
			}
		}
		args := []string{"worktree", "list", "--porcelain", "-z"}
		if explicitGitDir != "" {
			args = append([]string{"--bare"}, args...)
		}
		raw, err := gitCommon(ctx, common, args...)
		if err != nil {
			report.Warnings = append(report.Warnings, err.Error())
			continue
		}
		entries := parseList(raw)
		for _, w := range entries {
			registeredPaths[w.Path] = true
		}
		for _, w := range selectRegistrations(entries, common, report.Root, excluded, options) {
			report.Worktrees = append(report.Worktrees, w)
			if options.Progress != nil {
				// Registration snapshots are not modified by inspection workers.
				options.Progress(Progress{Stage: "discovery", Path: w.Path, Discovered: len(paths), Worktree: &w, Pending: true})
			}
		}
	}
	return nil
}

func fetchRepository(ctx context.Context, path string) error {
	// Fetch only on explicit request; never prune or change a local branch.
	// Unlike read-only recognition/listing, fetch must use ordinary Git
	// discovery so explicit-only bare and ownership policies still apply.
	_, err := run(ctx, 2*time.Minute, "git", "-c", "core.hooksPath=/dev/null", "-C", path, "fetch", "--all", "--no-recurse-submodules")
	return err
}

// selectRegistrations applies scan scope and assigns stable repository identity.
// The complete list is retained by the caller for discovery deduplication.
func selectRegistrations(entries []Worktree, common, root string, excluded func(string) bool, options Options) []Worktree {
	var selected []Worktree
	for i, w := range entries {
		w.Main = i == 0
		w.OutsideRoot = !within(root, w.Path)
		if (options.TargetOnly && w.Path != root) || (options.LinkedOnly && (w.Main || w.Bare || w.OutsideRoot)) || excluded(w.Path) {
			continue
		}
		w.CommonDir = common
		w.Repo = filepath.Base(filepath.Dir(common))
		if (w.Main && w.Bare) || (len(entries) > 0 && entries[0].Bare) {
			w.Repo = strings.TrimSuffix(filepath.Base(common), ".git")
		}
		sum := sha256.Sum256([]byte(common + "\x00" + w.Path))
		w.ID = hex.EncodeToString(sum[:12])
		selected = append(selected, w)
	}
	return selected
}
