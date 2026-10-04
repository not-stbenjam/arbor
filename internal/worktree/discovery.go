package worktree

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func discover(ctx context.Context, root string, excluded func(string) bool, progress func(Progress)) ([]string, []string, error) {
	var paths, warnings []string
	lastUpdate := time.Time{}
	update := func(path string, force bool) {
		if progress != nil && (force || time.Since(lastUpdate) >= 150*time.Millisecond) {
			progress(Progress{Stage: "discovery", Path: path, Discovered: len(paths)})
			lastUpdate = time.Now()
		}
	}
	update(root, true)
	found := func(path string) {
		paths = append(paths, path)
		if progress != nil {
			sum := sha256.Sum256([]byte(path))
			progress(Progress{Stage: "discovery", Path: path, Discovered: len(paths), Pending: true,
				Worktree: &Worktree{ID: hex.EncodeToString(sum[:12]), Path: path, Repo: filepath.Base(path)}})
			lastUpdate = time.Now()
		}
	}
	// Read each directory once and detect bare-repository markers in those
	// entries. Probing path/HEAD with Stat in every directory adds a syscall
	// for every folder in a home directory, including non-repository folders.
	stack := []string{root}
	for len(stack) > 0 {
		if ctx.Err() != nil {
			return paths, warnings, ctx.Err()
		}
		path := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if excluded(path) {
			continue
		}
		update(path, false)
		entries, err := os.ReadDir(path)
		if err != nil {
			if path == root {
				return paths, warnings, err
			}
			if len(warnings) < 100 {
				warnings = append(warnings, fmt.Sprintf("Cannot read %s: %v", path, err))
			}
			continue
		}
		marker, _, _ := repositoryMarkers(path, entries)
		kind, probeErr := recognizeRepository(ctx, path, entries)
		if probeErr != nil && len(warnings) < 100 {
			warnings = append(warnings, probeErr.Error())
		}
		if kind == repositoryBare {
			found(path)
			continue
		}
		if marker {
			// .git identifies this directory, not an independently excludable
			// child. A '*' rule must not hide an explicitly selected root.
			found(path)
		}
		// Reverse pushes retain WalkDir's lexical discovery order. Never follow
		// symlinks or skip a checkout's other directories: nested repos count.
		for i := len(entries) - 1; i >= 0; i-- {
			if ctx.Err() != nil {
				return paths, warnings, ctx.Err()
			}
			entry := entries[i]
			if entry.IsDir() && entry.Name() != ".git" {
				stack = append(stack, filepath.Join(path, entry.Name()))
			}
		}
	}
	update(root, true)
	return paths, warnings, nil
}
