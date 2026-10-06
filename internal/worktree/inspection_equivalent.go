package worktree

import (
	"bytes"
	"context"
	"os"
	"os/exec"
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

// copiesLimit is how many commits of its own a branch may have and still be
// compared with the default branch one commit at a time.
const copiesLimit = 50

// inspectEquivalent looks in the default branch for the changes of a branch
// whose own commits are not there. Merging by squash puts them there as one
// new commit, and merging by rebase as new commits one for one, so the
// branch is never an ancestor of what it was merged into.
//
// `git cherry` finds the commits that might be the same change, comparing
// patch IDs, which pass over white space. That is not sameness: indentation
// can be the whole of a change. So each match is confirmed with the patch ID
// that passes over nothing but line numbers, and a match that differs in a
// single space is no match. What is found is that the change was made in the
// default branch, at a commit that can be named. As with a branch that is an
// ancestor, it does not say the default branch has not changed since.
//
// It returns why the branch counts as merged, or nothing. Nothing is written
// to the repository. It needs Git 2.39, which is where the exact patch ID
// came in; with an older Git nothing is found this way.
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
	// Commits that undo one another change nothing, and nothing says they
	// were ever merged. Neither does a commit that changes nothing.
	trees := strings.Fields(gitText(ctx, w.Path, "rev-parse", w.Head+"^{tree}", base+"^{tree}"))
	if len(trees) != 2 || trees[0] == trees[1] {
		return ""
	}
	// A merge made on the branch can hold changes of its own, and comparing
	// commit by commit passes over merges. Such a branch is compared whole.
	merges, err := strconv.Atoi(gitText(ctx, w.Path, "rev-list", "--count", "--merges", base+".."+w.Head))
	if err != nil {
		return ""
	}
	if merges == 0 && own <= copiesLimit && copied(ctx, w) {
		return "Every commit was copied into " + w.DefaultRef + " (rebased or cherry-picked)"
	}
	// A branch of one commit and no merge was that comparison already.
	if own == 1 && merges == 0 {
		return ""
	}
	if commit := squashed(ctx, w, base, trees[0]); commit != "" {
		return "Squashed into " + w.DefaultRef + " as " + commit[:min(10, len(commit))]
	}
	return ""
}

// candidates lists the commits on one side of the default branch and a
// commit that `git cherry` would call the same as one on the other side.
// They are candidates only: see exactID.
func candidates(ctx context.Context, w *Worktree, env []string, side, other string) (same []string, all int, ok bool) {
	out, err := gitCompare(ctx, w.Path, env, "rev-list", "--cherry-mark", side, "--no-merges", w.DefaultRef+"..."+other)
	if err != nil {
		return nil, 0, false
	}
	for _, line := range strings.Fields(out) {
		all++
		if commit, found := strings.CutPrefix(line, "="); found {
			same = append(same, commit)
		}
	}
	return same, all, true
}

// copied reports whether every commit of the branch was made again in the
// default branch, exactly.
func copied(ctx context.Context, w *Worktree) bool {
	mine, all, ok := candidates(ctx, w, nil, "--right-only", w.Head)
	if !ok || all == 0 || len(mine) != all {
		return false
	}
	theirs, _, ok := candidates(ctx, w, nil, "--left-only", w.Head)
	if !ok || len(theirs) == 0 || len(theirs) > 4*copiesLimit {
		return false
	}
	there := map[string]bool{}
	for _, commit := range theirs {
		if id := exactID(ctx, w.Path, nil, commit+"^", commit); id != "" {
			there[id] = true
		}
	}
	for _, commit := range mine {
		if id := exactID(ctx, w.Path, nil, commit+"^", commit); id == "" || !there[id] {
			return false
		}
	}
	return true
}

// squashed finds the one commit in the default branch that makes exactly
// the changes the whole branch makes, and returns it.
func squashed(ctx context.Context, w *Worktree, base, tree string) string {
	wanted := exactID(ctx, w.Path, nil, base, tree)
	if wanted == "" {
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
	// folder of its own that is thrown away, never in the repository. The
	// folder is one Arbor has just made, and goes with whatever is in it.
	scratch, err := os.MkdirTemp("", "arbor-compare-")
	if err != nil {
		return ""
	}
	defer os.RemoveAll(scratch)
	env := []string{
		"GIT_OBJECT_DIRECTORY=" + scratch,
		"GIT_ALTERNATE_OBJECT_DIRECTORIES=" + quoteAlternate(objects),
		"GIT_AUTHOR_NAME=Arbor", "GIT_AUTHOR_EMAIL=arbor@localhost", "GIT_AUTHOR_DATE=@0 +0000",
		"GIT_COMMITTER_NAME=Arbor", "GIT_COMMITTER_EMAIL=arbor@localhost", "GIT_COMMITTER_DATE=@0 +0000",
	}
	whole, err := gitCompare(ctx, w.Path, env, "commit-tree", "--no-gpg-sign", "-p", base, "-m", "squashed", tree)
	whole = strings.TrimSpace(whole)
	if err != nil || whole == "" {
		return ""
	}
	theirs, _, ok := candidates(ctx, w, env, "--left-only", whole)
	if !ok || len(theirs) > 4*copiesLimit {
		return ""
	}
	for _, commit := range theirs {
		if exactID(ctx, w.Path, nil, commit+"^", commit) == wanted {
			return commit
		}
	}
	return ""
}

// exactID identifies the change from one tree to another by everything in
// it but its line numbers: every line added, removed and around them, white
// space included. Two changes with the same one are the same change. It is
// empty when there is no change, or none can be read.
func exactID(ctx context.Context, path string, env []string, from, to string) string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	prefix := []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-C", path}
	// The change is passed from one Git to the other as it is produced,
	// however large it is.
	diff := exec.CommandContext(ctx, "git", append(prefix, "diff-tree", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "-p", from, to)...)
	id := exec.CommandContext(ctx, "git", append(prefix, "patch-id", "--verbatim")...)
	environment := append(append(commandEnv(), env...), "GIT_NO_LAZY_FETCH=1", "GIT_EXTERNAL_DIFF=")
	diff.Env, id.Env = environment, environment
	diff.WaitDelay, id.WaitDelay = 2*time.Second, 2*time.Second
	pipe, err := diff.StdoutPipe()
	if err != nil {
		return ""
	}
	id.Stdin = pipe
	var out bytes.Buffer
	id.Stdout = &out
	if err := diff.Start(); err != nil {
		return ""
	}
	if err := id.Start(); err != nil {
		_ = diff.Process.Kill()
		_ = diff.Wait()
		return ""
	}
	// The reader is waited for first: it has finished only when it has read
	// all there was.
	idErr, diffErr := id.Wait(), diff.Wait()
	fields := strings.Fields(out.String())
	if idErr != nil || diffErr != nil || len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// partialClone reports whether a repository fetches file contents only when
// something asks for them. A remote that promises them says so, whether or
// not the repository is marked as a whole.
func partialClone(ctx context.Context, path string) bool {
	return gitText(ctx, path, "config", "--get", "extensions.partialClone") != "" ||
		gitText(ctx, path, "config", "--get-regexp", `^remote\..*\.(promisor|partialclonefilter)$`) != ""
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
