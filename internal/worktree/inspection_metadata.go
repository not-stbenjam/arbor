package worktree

import (
	"context"
	"os"
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

func inspectIndex(ctx context.Context, w *Worktree, block func(reasonCode)) {
	index, err := git(ctx, w.Path, "ls-files", "-v", "--stage", "-z")
	if err != nil {
		block(reasonIndex)
		block(reasonSubmoduleInspection)
		return
	}
	var sparse, submodules bool
	for _, line := range strings.Split(index, "\x00") {
		if len(line) > 0 && (line[0] == 'S' || (line[0] >= 'a' && line[0] <= 'z')) {
			sparse = true
		}
		if len(line) >= 2 && strings.HasPrefix(line[2:], "160000 ") {
			submodules = true
		}
	}
	if sparse {
		block(reasonSparse)
	}
	if submodules {
		block(reasonSubmodules)
	}
}

// inspectActivity combines operation markers and Git metadata timestamps with
// the file walk, which also identifies nested repositories and local byte size.
func inspectActivity(ctx context.Context, w *Worktree, block func(reasonCode)) {
	metadata, err := gitPaths(ctx, w.Path, []string{"rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "HEAD", "index", "logs/HEAD"})
	if err != nil {
		block(reasonMetadata)
		w.Problems = append(w.Problems, err.Error())
	} else {
		for _, p := range metadata[:6] {
			if _, err := os.Stat(p); err == nil {
				block(reasonOperation)
				break
			}
		}
	}
	measure(ctx, w, block)
	if len(metadata) == 9 {
		for _, path := range metadata[6:] {
			if st, err := os.Stat(path); err == nil && st.ModTime().After(w.ActivityAt) {
				w.ActivityAt = st.ModTime()
			}
		}
	}
}
