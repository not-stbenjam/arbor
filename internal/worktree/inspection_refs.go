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
	// repository is the path the repository was found at, for its warning.
	repository string
	// unconfirmed says, per remote, why this scan's fetch could not learn the
	// remote's default branch. It is complete before inspection starts.
	unconfirmed map[string]string
	// problem says why nothing decides what is merged here, when a remote
	// should have. It is written once, with ref.
	problem string
	// partial says whether this is a partial clone, asked once.
	partialOnce sync.Once
	partial     bool
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

// decidingRemote is the one remote whose default branch decides what is
// merged. A remote has that role when it is configured or when any of its
// branches are recorded here, and keeps it even when its default branch is
// not known yet: another remote's branches say nothing about this one's.
func decidingRemote(ctx context.Context, path string, configured []string) string {
	for _, remote := range defaultRemotes {
		if slices.Contains(configured, remote) || tracksRemote(ctx, path, remote) {
			return remote
		}
	}
	return ""
}

// inspectMerge compares the worktree with the branch that decides what is
// merged. It reports whether anything may decide at all: when the remote
// that should have named that branch could not, no other evidence is taken
// in its place, so nothing in the repository is recommended.
func inspectMerge(ctx context.Context, w *Worktree, defaultCache *repositoryDefault, block func(reasonCode)) (decided bool) {
	var problem string
	if defaultCache == nil {
		w.DefaultRef, problem = defaultRef(ctx, w.Path, nil)
	} else {
		defaultCache.once.Do(func() {
			defaultCache.ref, defaultCache.problem = defaultRef(ctx, w.Path, defaultCache.unconfirmed)
		})
		w.DefaultRef, problem = defaultCache.ref, defaultCache.problem
	}
	if w.DefaultRef != "" {
		_, err := git(ctx, w.Path, "merge-base", "--is-ancestor", w.Head, w.DefaultRef)
		w.Merged = err == nil
		if w.Merged {
			w.MergeReason = "All commits are in " + w.DefaultRef
		} else if reason := inspectEquivalent(ctx, w, func() bool {
			if defaultCache == nil {
				return partialClone(ctx, w.Path)
			}
			defaultCache.partialOnce.Do(func() { defaultCache.partial = partialClone(ctx, w.Path) })
			return defaultCache.partial
		}); reason != "" {
			w.Merged, w.MergeReason = true, reason
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
	return problem == ""
}

// learnedDefault is the repository setting in which a fetch records the
// default branch a remote named when this clone does not track that branch.
// Git has no selector for a branch that is not here, and without a record
// the next scan would go back to the older selector or the usual names, both
// then known to be out of date.
//
// The record only ever withholds. It says what was true when the remote was
// last asked, so it never names the default branch itself, even once that
// branch has been fetched: the remote may have moved on again. Asking the
// remote, in a scan that fetches, is the one thing that clears it.
func learnedDefault(remote string) string { return "arbor." + remote + ".head" }

// defaultRef finds the branch that decides what is merged. When a remote
// should have named it and could not, there is none, and problem says why:
// guessing from another remote or a local branch could call unfinished work
// merged.
func defaultRef(ctx context.Context, path string, unconfirmed map[string]string) (ref, problem string) {
	exists := func(ref string) bool {
		return gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != ""
	}
	// Without a remote to ask, only a conventional name identifies the
	// default branch. Nothing else in a repository says which one it is.
	local := func() string {
		for _, branch := range defaultBranches {
			if ref := "refs/heads/" + branch; exists(ref) {
				return ref
			}
		}
		return ""
	}
	remote := decidingRemote(ctx, path, strings.Fields(gitText(ctx, path, "remote")))
	if remote == "" {
		return local(), ""
	}
	if reason := unconfirmed[remote]; reason != "" {
		return "", reason
	}
	prefix := "refs/remotes/" + remote + "/"
	if branch := gitText(ctx, path, "config", "--local", "--get", learnedDefault(remote)); branch != "" {
		return "", remote + " last named " + branch + " as its default branch, and this clone has not caught up with that. Scan with fetching on again, after fetching that branch if it is missing"
	}
	if ref := gitText(ctx, path, "symbolic-ref", prefix+"HEAD"); ref != "" {
		if exists(ref) {
			return ref, ""
		}
		// The branch the remote called its default is gone from here, so its
		// default has changed. Which branch took its place is not a guess.
		return "", "the branch recorded as the default of " + remote + ", " + strings.TrimPrefix(ref, prefix) + ", is no longer here. Scan once with fetching on, or run `git remote set-head " + remote + " --auto` there"
	}
	for _, branch := range defaultBranches {
		if ref := prefix + branch; exists(ref) {
			return ref, ""
		}
	}
	switch {
	case tracksRemote(ctx, path, remote):
		return "", "the default branch of " + remote + " is not known. Scan once with fetching on, or run `git remote set-head " + remote + " --auto` there"
	case remote == "origin":
		// Nothing of origin is tracked. A bare clone keeps origin's branches
		// as its own, and a repository that has exchanged nothing with
		// origin has only its own.
		return local(), ""
	default:
		return "", remote + " has not been fetched, so what has been merged into it is not known. Fetch it, or scan with fetching on"
	}
}

// tracksRemote reports whether any of a remote's branches are recorded here.
func tracksRemote(ctx context.Context, path, remote string) bool {
	return gitText(ctx, path, "for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/"+remote+"/") != ""
}

func untrackedDefault(remote, branch string) string {
	return "the default branch of " + remote + " is " + branch + ", which is not fetched here"
}
