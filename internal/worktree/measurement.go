package worktree

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
)

// measure walks the worktree's files. submodules are the folders of its own
// checked-out submodules: each is a repository inside the folder, but one the
// worktree accounts for, and is reported as a submodule rather than as a
// stray nested repository.
func measure(ctx context.Context, w *Worktree, block func(reasonCode), submodules []string) {
	nested := false
	err := filepath.WalkDir(w.Path, func(path string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			return err
		}
		if d.Name() == ".git" {
			if parent := filepath.Dir(path); parent != w.Path && !slices.Contains(submodules, parent) {
				nested = true
			}
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() == "HEAD" && filepath.Dir(path) != w.Path {
			// WalkDir already read the parent; re-read only these rare candidate
			// directories rather than adding a stat/Git probe for every folder.
			parent := filepath.Dir(path)
			entries, readErr := os.ReadDir(parent)
			if readErr != nil {
				return readErr
			}
			kind, probeErr := recognizeRepository(ctx, parent, entries)
			if probeErr != nil {
				return probeErr
			}
			if kind != repositoryNone {
				nested = true
				// HEAD is a file in valid Git metadata. Skip its remaining
				// siblings, including the independent objects/refs database.
				return filepath.SkipDir
			}
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			w.SizeBytes += info.Size()
		}
		if info.ModTime().After(w.ActivityAt) {
			w.ActivityAt = info.ModTime()
		}
		return nil
	})
	if nested {
		block(reasonNested)
	}
	if err != nil {
		block(reasonFiles)
		w.Problems = append(w.Problems, err.Error())
	}
}
