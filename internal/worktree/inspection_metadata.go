package worktree

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func inspectCommit(ctx context.Context, w *Worktree) {
	meta, err := git(ctx, w.Path, "show", "-s", "--format=%s%x00%an%x00%cI", "HEAD")
	if err != nil {
		w.Problems = append(w.Problems, err.Error())
		return
	}
	parts := strings.Split(strings.TrimSpace(meta), "\x00")
	if len(parts) == 3 {
		w.Subject = parts[0]
		w.Author = parts[1]
		w.CommitAt, _ = time.Parse(time.RFC3339, parts[2])
		w.ActivityAt = w.CommitAt
	}
}

func inspectStatus(ctx context.Context, w *Worktree, block func(reasonCode)) {
	status, err := git(ctx, w.Path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none")
	if err != nil {
		block(reasonStatus)
		w.Problems = append(w.Problems, err.Error())
	} else {
		items := strings.Split(status, "\x00")
		for i := 0; i < len(items); i++ {
			item := items[i]
			if len(item) < 3 {
				continue
			}
			if strings.HasPrefix(item, "!!") {
				w.Ignored = true
				continue
			}
			w.Dirty = true
			w.ChangedFiles++
			if strings.ContainsAny(item[:2], "RC") {
				i++
			}
		}
	}
	if w.Dirty {
		block(reasonDirty)
	}
	if w.Ignored {
		block(reasonIgnored)
	}
}

// inspectIndex reads what the index says about files Git will not vouch for.
// It returns the folders of the submodules that are checked out.
func inspectIndex(ctx context.Context, w *Worktree, block func(reasonCode)) (submodules []string) {
	index, err := git(ctx, w.Path, "ls-files", "-v", "--stage", "-z")
	if err != nil {
		block(reasonIndex)
		block(reasonSubmoduleInspection)
		return nil
	}
	unchecked := false
	for _, line := range strings.Split(index, "\x00") {
		if len(line) == 0 {
			continue
		}
		_, name, found := strings.Cut(line, "\t")
		entry := filepath.Join(w.Path, filepath.FromSlash(name))
		// With -v, an upper-case S marks a file as skip-worktree and a lower-
		// case letter marks it assume-unchanged. Git does not look at either,
		// so its status cannot vouch for what such a file holds.
		if tag := line[0]; tag == 'S' || (tag >= 'a' && tag <= 'z') {
			// A sparse checkout leaves the files it skips out of the folder,
			// and a file that is not there holds nothing Git failed to
			// report. Only one that is present can hide a change.
			if (tag != 'S' && tag != 's') || !found || present(entry) {
				unchecked = true
			}
		}
		if len(line) >= 2 && strings.HasPrefix(line[2:], "160000 ") {
			switch {
			case !found || present(filepath.Join(entry, ".git")):
				// Checked out: a repository of its own, which this worktree's
				// status says nothing about and which keeps its own commits.
				submodules = append(submodules, entry)
			case !vacant(entry):
				// Not checked out, yet something is in its folder. Git does
				// not look inside a submodule's folder, so nothing reports it.
				unchecked = true
			}
		}
	}
	if unchecked {
		block(reasonUnchecked)
	}
	if len(submodules) > 0 {
		block(reasonSubmodules)
	}
	return submodules
}

// operationMarkers are what Git keeps in a worktree's own metadata while an
// operation is unfinished. A sequence of several cherry-picks or reverts can
// be between commits with none of the single-commit markers present, and
// leaves only its "sequencer" folder.
var operationMarkers = []string{"rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer"}

// unfinished reports whether any of an operation's markers is present.
func unfinished(markers []string) bool {
	for _, marker := range markers {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return false
}

// inspectActivity combines operation markers and Git metadata timestamps with
// the file walk, which also identifies nested repositories and local byte
// size. It returns where this worktree's operation markers would be, and
// where Git keeps the repositories of its submodules.
func inspectActivity(ctx context.Context, w *Worktree, block func(reasonCode), submodules []string) (markers []string, modules string) {
	names := append(slices.Clone(operationMarkers), "HEAD", "index", "logs/HEAD", "modules")
	metadata, err := gitPaths(ctx, w.Path, names)
	if err != nil || len(metadata) != len(names) {
		block(reasonMetadata)
		if err != nil {
			w.Problems = append(w.Problems, err.Error())
		}
		measure(ctx, w, block, submodules)
		return nil, ""
	}
	markers, modules = metadata[:len(operationMarkers)], metadata[len(names)-1]
	if unfinished(markers) {
		block(reasonOperation)
	}
	if holdsSubmodules(modules) {
		block(reasonSubmodules)
	}
	measure(ctx, w, block, submodules)
	for _, path := range metadata[len(operationMarkers) : len(names)-1] {
		if st, err := os.Stat(path); err == nil && st.ModTime().After(w.ActivityAt) {
			w.ActivityAt = st.ModTime()
		}
	}
	return markers, modules
}

// holdsSubmodules reports whether Git is keeping submodule repositories for a
// worktree. Git refuses an unforced removal while this folder exists, whether
// or not any submodule is still checked out, and a forced one deletes it
// along with any commits in it that were never pushed.
func holdsSubmodules(modules string) bool {
	st, err := os.Stat(modules)
	return modules != "" && err == nil && st.IsDir()
}

// adminDirectory finds where a repository keeps a linked worktree's own
// metadata. It does not need the worktree's folder to exist: each such
// directory records the folder it belongs to.
func adminDirectory(common, path string) string {
	entries, err := os.ReadDir(filepath.Join(common, "worktrees"))
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		directory := filepath.Join(common, "worktrees", entry.Name())
		data, err := os.ReadFile(filepath.Join(directory, "gitdir"))
		if err != nil {
			continue
		}
		pointer := strings.TrimRight(string(data), "\r\n")
		if !filepath.IsAbs(pointer) {
			pointer = filepath.Join(directory, pointer)
		}
		if filepath.Clean(pointer) == filepath.Join(path, ".git") {
			return directory
		}
	}
	return ""
}

// vacant reports whether a folder is absent or empty.
func vacant(path string) bool {
	entries, err := os.ReadDir(path)
	return os.IsNotExist(err) || (err == nil && len(entries) == 0)
}

// present reports whether anything is at path. A path that cannot be examined
// counts as present: what cannot be seen is not known to be absent.
func present(path string) bool {
	_, err := os.Lstat(path)
	return err == nil || !os.IsNotExist(err)
}
