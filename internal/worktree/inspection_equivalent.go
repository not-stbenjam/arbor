package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// equivalenceLimit is how many commits the default branch may have gained
// since a branch left it before Arbor stops looking through them for that
// branch's changes. Looking takes time in proportion: about a tenth of a
// second for each thousand.
var equivalenceLimit = 20000

// inspectEquivalent looks in the default branch for the changes of a branch
// whose own commits are not there. Merging by squash puts them there as one
// new commit, and merging by rebase as new commits one for one, so the
// branch is never an ancestor of what it was merged into.
//
// Two changes are the same when Git gives them the same patch ID: the same
// lines added and removed in the same files, wherever in those files they
// have since moved to. It is what `git cherry` compares. A branch found this
// way has nothing the default branch lacks except the commits themselves,
// and the branch still has those once its worktree is gone.
//
// It returns why the branch counts as merged, or nothing. Nothing is written
// to the repository.
func inspectEquivalent(ctx context.Context, w *Worktree, partial func() bool) string {
	if w.Detached || w.Head == "" || w.DefaultRef == "" {
		return ""
	}
	// How far each side has gone since they parted: the commits only here,
	// and those only in the default branch.
	counts := strings.Fields(gitText(ctx, w.Path, "rev-list", "--count", "--left-right", w.Head+"..."+w.DefaultRef))
	if len(counts) != 2 {
		return ""
	}
	own, _ := strconv.Atoi(counts[0])
	since, _ := strconv.Atoi(counts[1])
	if own == 0 || since == 0 || since > equivalenceLimit {
		return ""
	}
	// Histories with nothing in common were never one branch leaving another,
	// whatever their files have in common.
	base := gitText(ctx, w.Path, "merge-base", w.Head, w.DefaultRef)
	if base == "" {
		return ""
	}
	// Comparing changes reads file contents, which a partial clone would
	// have to fetch.
	if partial() {
		return ""
	}
	// Rebased or cherry-picked: every commit here has its equal there.
	marks, err := gitCompare(ctx, w.Path, nil, "cherry", w.DefaultRef, w.Head)
	if err != nil {
		return ""
	}
	if allEquivalent(marks) {
		return "All commits are in " + w.DefaultRef + ", as copies (rebased or cherry-picked)"
	}
	// Squashed: one commit there makes every change made here. A branch of
	// one commit was that comparison already, unless it also merged
	// something in, which `git cherry` passes over.
	if own == 1 && strings.Count(marks, "\n") == 1 {
		return ""
	}
	trees := strings.Fields(gitText(ctx, w.Path, "rev-parse", w.Head+"^{tree}", base+"^{tree}"))
	if len(trees) != 2 || trees[0] == trees[1] {
		// Commits that undo one another change nothing, and nothing says
		// they were ever merged.
		return ""
	}
	objects := filepath.Join(w.CommonDir, "objects")
	if w.CommonDir == "" {
		found, err := gitPaths(ctx, w.Path, []string{"objects"})
		if err != nil {
			return ""
		}
		objects = found[0]
	}
	// Git compares commits, so the branch's changes are made into one, in a
	// folder of its own that is thrown away, never in the repository.
	scratch, err := os.MkdirTemp("", "arbor-compare-")
	if err != nil {
		return ""
	}
	env := []string{
		"GIT_OBJECT_DIRECTORY=" + scratch,
		"GIT_ALTERNATE_OBJECT_DIRECTORIES=" + quoteAlternate(objects),
		"GIT_AUTHOR_NAME=Arbor", "GIT_AUTHOR_EMAIL=arbor@localhost", "GIT_AUTHOR_DATE=@0 +0000",
		"GIT_COMMITTER_NAME=Arbor", "GIT_COMMITTER_EMAIL=arbor@localhost", "GIT_COMMITTER_DATE=@0 +0000",
	}
	squashed, err := gitCompare(ctx, w.Path, env, "commit-tree", "--no-gpg-sign", "-p", base, "-m", "squashed", trees[0])
	squashed = strings.TrimSpace(squashed)
	// Git wrote one file, in a folder named for it. Exactly those are removed.
	defer func() {
		if len(squashed) > 2 {
			_ = os.Remove(filepath.Join(scratch, squashed[:2], squashed[2:]))
			_ = os.Remove(filepath.Join(scratch, squashed[:2]))
		}
		_ = os.Remove(scratch)
	}()
	if err != nil || squashed == "" {
		return ""
	}
	if marks, err := gitCompare(ctx, w.Path, env, "cherry", w.DefaultRef, squashed); err == nil && allEquivalent(marks) {
		return "All changes are in " + w.DefaultRef + ", as one commit (squashed)"
	}
	return ""
}

// partialClone reports whether a repository fetches file contents only when
// something asks for them.
func partialClone(ctx context.Context, path string) bool {
	return gitText(ctx, path, "config", "--get", "extensions.partialClone") != ""
}

// allEquivalent reads what `git cherry` printed: a line for each commit,
// marked "-" when the other side has its equal and "+" when it does not.
func allEquivalent(marks string) bool {
	lines := strings.Split(strings.TrimSpace(marks), "\n")
	for _, line := range lines {
		if !strings.HasPrefix(line, "- ") {
			return false
		}
	}
	return len(lines) > 0
}

// gitCompare runs a Git command that reads history, with a shorter patience
// than inspection has: a scan does not wait long to learn that something
// might also count as merged. Contents are never fetched for it, and no
// program a repository names is run to show or convert them.
func gitCompare(ctx context.Context, path string, env []string, args ...string) (string, error) {
	prefix := []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "log.showSignature=false", "-c", "diff.external=", "-C", path}
	return runWith(ctx, 10*time.Second, append(env, "GIT_NO_LAZY_FETCH=1", "GIT_EXTERNAL_DIFF="), "git", append(prefix, args...)...)
}

// quoteAlternate writes a folder as one entry of the list Git reads other
// object folders from. Entries are separated by colons, so a path is given
// in quotes, as Git's own quoting of unusual paths.
func quoteAlternate(path string) string {
	var quoted strings.Builder
	quoted.WriteByte('"')
	for i := 0; i < len(path); i++ {
		switch c := path[i]; c {
		case '"', '\\':
			quoted.WriteByte('\\')
			quoted.WriteByte(c)
		case '\n':
			quoted.WriteString(`\n`)
		default:
			quoted.WriteByte(c)
		}
	}
	quoted.WriteByte('"')
	return quoted.String()
}
