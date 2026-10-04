package worktree

import (
	"context"
	"strconv"
	"strings"
	"sync"
)

// Scan shares ref lookup only within its snapshot. Removal calls inspect with
// no cache, so all deletion decisions continue to use fresh repository state.
type repositoryDefault struct {
	once sync.Once
	ref  string
}

func inspectPublication(ctx context.Context, w *Worktree) {
	w.Upstream = gitText(ctx, w.Path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if w.Upstream != "" {
		counts := strings.Fields(gitText(ctx, w.Path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"))
		if len(counts) == 2 {
			w.Ahead, _ = strconv.Atoi(counts[0])
			w.Behind, _ = strconv.Atoi(counts[1])
		}
	}
	refs := gitText(ctx, w.Path, "for-each-ref", "--contains=HEAD", "--format=%(refname)", "refs/remotes/")
	for _, ref := range strings.Split(refs, "\n") {
		if ref != "" && !strings.HasSuffix(ref, "/HEAD") {
			w.PublishedRefs = append(w.PublishedRefs, strings.TrimPrefix(ref, "refs/remotes/"))
		}
	}
	w.Published = len(w.PublishedRefs) > 0
}

func inspectMerge(ctx context.Context, w *Worktree, defaultCache *repositoryDefault, block func(reasonCode)) {
	if defaultCache == nil {
		w.DefaultRef = defaultRef(ctx, w.Path)
	} else {
		defaultCache.once.Do(func() { defaultCache.ref = defaultRef(ctx, w.Path) })
		w.DefaultRef = defaultCache.ref
	}
	if w.DefaultRef != "" {
		_, err := git(ctx, w.Path, "merge-base", "--is-ancestor", w.Head, w.DefaultRef)
		w.Merged = err == nil
		if w.Merged {
			w.MergeReason = "All commits are in " + w.DefaultRef
		}
		defaultBranch := strings.TrimPrefix(w.DefaultRef, "refs/heads/")
		if strings.HasPrefix(w.DefaultRef, "refs/remotes/") {
			_, defaultBranch, _ = strings.Cut(strings.TrimPrefix(w.DefaultRef, "refs/remotes/"), "/")
		}
		if w.Branch == defaultBranch {
			block(reasonDefaultBranch)
		}
	}
	if w.Branch == "main" || w.Branch == "master" || w.Branch == "develop" {
		block(reasonProtectedBranch)
	}
}

func defaultRef(ctx context.Context, path string) string {
	for _, remote := range []string{"upstream", "origin"} {
		ref := gitText(ctx, path, "symbolic-ref", "refs/remotes/"+remote+"/HEAD")
		if ref != "" && gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != "" {
			return ref
		}
		for _, branch := range []string{"main", "master"} {
			ref := "refs/remotes/" + remote + "/" + branch
			if gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != "" {
				return ref
			}
		}
	}
	for _, branch := range []string{"main", "master"} {
		ref := "refs/heads/" + branch
		if gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != "" {
			return ref
		}
	}
	return ""
}
