package worktree

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
)

func measure(ctx context.Context, w *Worktree, block func(reasonCode)) {
	nested := false
	err := filepath.WalkDir(w.Path, func(path string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			return err
		}
		if d.Name() == ".git" {
			if filepath.Dir(path) != w.Path {
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
