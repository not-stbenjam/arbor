package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

func inspect(ctx context.Context, w *Worktree, options Options) {
	inspectWithDefault(ctx, w, options, nil)
}

// Scan shares ref lookup only within its snapshot. Removal calls inspect with
// no cache, so all deletion decisions continue to use fresh repository state.
type repositoryDefault struct {
	once sync.Once
	ref  string
}

func inspectWithDefault(ctx context.Context, w *Worktree, options Options, defaultCache *repositoryDefault) {
	// Git's prunable marker also describes existing directories without .git.
	// Classify the actual path, rather than treating every prunable entry as absent.
	w.Missing = false
	w.Empty = false
	w.Blockers = []string{}
	w.Problems = []string{}
	w.PublishedRefs = []string{}
	w.GitHubState = "not_checked"
	var reasons []reasonCode
	verified := false
	block := func(reason reasonCode) { reasons = append(reasons, reason) }
	defer func() {
		for _, reason := range reasons {
			w.Blockers = append(w.Blockers, reasonMessage(reason))
		}
		decision := evaluateRemoval(removalFacts{reasons: reasons, verified: verified, problems: len(w.Problems) > 0, merged: w.Merged})
		w.CanRemove, w.CanDiscard, w.Recommended = decision.canRemove, decision.canDiscard, decision.recommended
		w.DiscardWarnings = decision.warnings
	}()
	if w.Main {
		block(reasonPrimary)
	}
	if w.Bare {
		block(reasonBare)
		return
	}
	if w.OutsideRoot {
		block(reasonOutside)
	}
	if w.Locked {
		block(reasonLocked)
	}
	if w.Detached {
		block(reasonDetached)
	}
	if st, err := os.Stat(w.Path); err != nil || !st.IsDir() {
		w.Missing = true
		block(reasonMissing)
		if os.IsNotExist(err) {
			canonical, pathErr := resolveMissingRoot(w.Path)
			if pathErr != nil || canonical != w.Path {
				block(reasonUnverifiedPath)
			} else if len(w.Head) < 40 || gitCommonText(ctx, w.CommonDir, "rev-parse", "--verify", w.Head+"^{commit}") != w.Head {
				block(reasonNoCommit)
			} else {
				verified = true
			}
		}
		return
	}
	// Resolve both ownership properties in one Git process. A copied repository
	// can retain a stale registration pointing at another repository's checkout.
	// Matching the exact expected prefix also preserves newlines in path names.
	identity, identityErr := git(ctx, w.Path, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
	common, ownsPath := strings.CutPrefix(identity, w.Path+"\n")
	if identityErr != nil || !ownsPath {
		if emptyCheckoutDirectory(w.Path) {
			w.Empty = true
			block(reasonEmpty)
			if len(w.Head) < 40 || gitCommonText(ctx, w.CommonDir, "rev-parse", "--verify", w.Head+"^{commit}") != w.Head {
				block(reasonNoCommit)
			} else {
				verified = true
			}
			return
		}
		block(reasonUnverifiedPath)
		return
	}
	actualCommon, commonErr := filepath.EvalSymlinks(strings.TrimSuffix(common, "\n"))
	if commonErr != nil || actualCommon != w.CommonDir {
		block(reasonUnverifiedPath)
		return
	}
	w.Head = gitText(ctx, w.Path, "rev-parse", "--verify", "HEAD")
	if len(w.Head) < 40 {
		block(reasonNoCommit)
		return
	}
	meta, err := git(ctx, w.Path, "show", "-s", "--format=%s%x00%an%x00%cI", "HEAD")
	if err != nil {
		w.Problems = append(w.Problems, err.Error())
	} else {
		parts := strings.Split(strings.TrimSpace(meta), "\x00")
		if len(parts) == 3 {
			w.Subject = parts[0]
			w.Author = parts[1]
			w.CommitAt, _ = time.Parse(time.RFC3339, parts[2])
			w.ActivityAt = w.CommitAt
		}
	}
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
	index, err := git(ctx, w.Path, "ls-files", "-v", "--stage", "-z")
	if err != nil {
		block(reasonIndex)
		block(reasonSubmoduleInspection)
	} else {
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
	if options.GitHub {
		checkGitHub(ctx, w)
	}
	verified = true
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
