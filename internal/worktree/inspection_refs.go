package worktree

import (
	"context"
	"slices"
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

// defaultRemotes are the remotes whose default branch decides what is merged,
// in order of authority: a fork's upstream, then the origin.
var defaultRemotes = []string{"upstream", "origin"}

// defaultBranches are the conventional names tried when nothing says which
// branch is the default.
var defaultBranches = []string{"main", "master", "trunk"}

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
	if slices.Contains(defaultBranches, w.Branch) || w.Branch == "develop" {
		block(reasonProtectedBranch)
	}
}

func defaultRef(ctx context.Context, path string) string {
	exists := func(ref string) bool {
		return gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != ""
	}
	for _, remote := range defaultRemotes {
		if ref := gitText(ctx, path, "symbolic-ref", "refs/remotes/"+remote+"/HEAD"); ref != "" && exists(ref) {
			return ref
		}
		for _, branch := range defaultBranches {
			if ref := "refs/remotes/" + remote + "/" + branch; exists(ref) {
				return ref
			}
		}
	}
	// A repository with no remote says nothing about its default branch.
	// Conventional names come first; the name this user's Git gives new
	// repositories is the last resort, never a reason to prefer it over one
	// of those.
	local := defaultBranches
	if configured := gitText(ctx, path, "config", "--get", "init.defaultBranch"); configured != "" {
		local = append(slices.Clone(local), configured)
	}
	for _, branch := range local {
		if ref := "refs/heads/" + branch; exists(ref) {
			return ref
		}
	}
	return ""
}
