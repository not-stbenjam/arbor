package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testTopic makes an established worktree with these commits, each writing
// one file.
func testTopic(t *testing.T, repo, path, branch string, files ...string) string {
	t.Helper()
	testLinked(t, repo, path, branch)
	for _, name := range files {
		testWrite(t, filepath.Join(path, name), "work in "+name+"\n")
		testGit(t, path, "add", name)
		testGit(t, path, "commit", "-m", "Add "+name)
	}
	return path
}

func testSquash(t *testing.T, repo, branch string) {
	t.Helper()
	testGit(t, repo, "merge", "--squash", branch)
	testGit(t, repo, "commit", "-m", "Squash "+branch)
}

// testObjects lists every file among a repository's objects.
func testObjects(t *testing.T, repo string) []string {
	t.Helper()
	var names []string
	err := filepath.WalkDir(filepath.Join(repo, ".git", "objects"), func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			names = append(names, path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func TestSquashedBranchIsMerged(t *testing.T) {
	root := t.TempDir()
	scratch := t.TempDir()
	t.Setenv("TMPDIR", scratch)
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt", "two.txt", "three.txt")
	if w := testTree(t, testScan(t, root), topic); w.Merged || w.Recommended {
		t.Fatalf("an unmerged branch counts as merged: %+v", w)
	}
	testSquash(t, repo, "topic")
	before := testObjects(t, repo)
	w := testTree(t, testScan(t, root), topic)
	squash := testGit(t, repo, "rev-parse", "HEAD")
	if !w.Merged || !w.Recommended || w.MergeReason != "Squashed into refs/heads/main as "+squash[:10] {
		t.Fatalf("a squashed branch is not merged: merged=%v recommended=%v reason=%q blockers=%v", w.Merged, w.Recommended, w.MergeReason, w.Blockers)
	}
	if after := testObjects(t, repo); strings.Join(after, "\n") != strings.Join(before, "\n") {
		t.Fatalf("looking wrote to the repository: %d objects became %d", len(before), len(after))
	}
	if left, _ := os.ReadDir(scratch); len(left) != 0 {
		t.Fatalf("looking left %d things behind in the temporary folder", len(left))
	}

	// The default branch moving on, over the same lines, does not unmerge it.
	testWrite(t, filepath.Join(repo, "two.txt"), "rewritten since\n")
	testGit(t, repo, "commit", "-am", "Rewrite two")
	if w := testTree(t, testScan(t, root), topic); !w.Recommended {
		t.Fatalf("later work on the default branch hid the squash: %+v", w)
	}

	// More work on the branch after it was squashed is not in the default branch.
	testWrite(t, filepath.Join(topic, "four.txt"), "later\n")
	testGit(t, topic, "add", "four.txt")
	testGit(t, topic, "commit", "-m", "Carry on")
	if w := testTree(t, testScan(t, root), topic); w.Merged || w.Recommended || w.MergeReason != "" {
		t.Fatalf("work added after the squash counts as merged: %+v", w)
	}
}

func TestRebasedBranchIsMerged(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt", "two.txt")
	partial := testTopic(t, repo, filepath.Join(root, "partial"), "partial", "three.txt", "four.txt")
	// The default branch moves first, so the copies are new commits.
	testWrite(t, filepath.Join(repo, "tracked.txt"), "moved on\n")
	testGit(t, repo, "commit", "-am", "Move on")
	testGit(t, repo, "cherry-pick", "topic~1", "topic")
	testGit(t, repo, "cherry-pick", "partial~1")
	report := testScan(t, root)
	if w := testTree(t, report, topic); !w.Recommended || w.MergeReason != "Every commit was copied into refs/heads/main (rebased or cherry-picked)" {
		t.Fatalf("a rebased branch is not merged: merged=%v reason=%q", w.Merged, w.MergeReason)
	}
	// One of two commits copied is not the branch merged.
	if w := testTree(t, report, partial); w.Merged || w.Recommended {
		t.Fatalf("a branch with one commit of two copied counts as merged: %+v", w)
	}
}

func TestSquashAfterTheDefaultBranchWasMergedIn(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt")
	testWrite(t, filepath.Join(repo, "elsewhere.txt"), "meanwhile\n")
	testGit(t, repo, "add", "elsewhere.txt")
	testGit(t, repo, "commit", "-m", "Meanwhile")
	testGit(t, topic, "merge", "--no-edit", "main")
	testWrite(t, filepath.Join(topic, "two.txt"), "after catching up\n")
	testGit(t, topic, "add", "two.txt")
	testGit(t, topic, "commit", "-m", "Add two")
	testSquash(t, repo, "topic")
	if w := testTree(t, testScan(t, root), topic); !w.Recommended || !strings.Contains(w.MergeReason, "Squashed into") {
		t.Fatalf("a branch that caught up before it was squashed is not merged: merged=%v reason=%q", w.Merged, w.MergeReason)
	}
}

func TestChangesThatAreNotInTheDefaultBranchAreNotMerged(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	// Commits that undo one another: nothing changed, and nothing was merged.
	undone := testTopic(t, repo, filepath.Join(root, "undone"), "undone", "one.txt")
	testGit(t, undone, "revert", "--no-edit", "HEAD")
	// The same file, with different contents.
	different := testTopic(t, repo, filepath.Join(root, "different"), "different", "shared.txt")
	testWrite(t, filepath.Join(repo, "shared.txt"), "another idea altogether\n")
	testGit(t, repo, "add", "shared.txt")
	testGit(t, repo, "commit", "-m", "Add shared")
	// Part of a branch's changes.
	half := testTopic(t, repo, filepath.Join(root, "half"), "half", "a.txt", "b.txt")
	testWrite(t, filepath.Join(repo, "a.txt"), "work in a.txt\n")
	testGit(t, repo, "add", "a.txt")
	testGit(t, repo, "commit", "-m", "Add a only")
	report := testScan(t, root)
	for _, path := range []string{undone, different, half} {
		if w := testTree(t, report, path); w.Merged || w.Recommended || w.MergeReason != "" {
			t.Fatalf("%s counts as merged: reason=%q", filepath.Base(path), w.MergeReason)
		}
	}
}

func TestLookingForASquashStopsAtItsLimit(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt", "two.txt")
	testSquash(t, repo, "topic")
	testGit(t, repo, "commit", "--allow-empty", "-m", "One more")
	w := testTree(t, testScan(t, root), topic)
	if reason := inspectEquivalent(context.Background(), &w, func() bool { return false }); !strings.Contains(reason, "Squashed into") {
		t.Fatalf("reason = %q", reason)
	}
	if reason := inspectEquivalent(context.Background(), &w, func() bool { return true }); reason != "" {
		t.Fatalf("compared changes in a partial clone: %q", reason)
	}
	previous := equivalenceLimit
	equivalenceLimit = 1
	defer func() { equivalenceLimit = previous }()
	if reason := inspectEquivalent(context.Background(), &w, func() bool { return false }); reason != "" {
		t.Fatalf("looked through more commits than the limit: %q", reason)
	}
}

// A repository may name programs for Git to show or convert files with.
// Comparing changes must not run them.
func TestComparingChangesRunsNothingTheRepositoryNames(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.bin", "two.bin")
	canary := filepath.Join(root, "ran")
	script := filepath.Join(root, "run.sh")
	testWrite(t, script, "#!/bin/sh\necho ran >> "+canary+"\ncat \"$1\" 2>/dev/null\n")
	if err := os.Chmod(script, 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(repo, ".gitattributes"), "*.bin diff=loud\n")
	testGit(t, repo, "add", ".gitattributes")
	testGit(t, repo, "commit", "-m", "Attributes")
	testSquash(t, repo, "topic")
	for key, value := range map[string]string{
		"diff.external":      script,
		"diff.loud.textconv": script,
		"diff.loud.command":  script,
		"core.pager":         script,
	} {
		testGit(t, repo, "config", key, value)
	}
	_ = os.Remove(canary)
	w := testTree(t, testScan(t, root), topic)
	if !w.Merged {
		t.Fatalf("the squash was not found: %+v", w)
	}
	if _, err := os.Stat(canary); err == nil {
		t.Fatal("comparing changes ran a program named by the repository")
	}
}

// Git reads a list of object folders separated by colons, and this
// repository's path has one, and a quote.
func TestSquashIsFoundInARepositoryWithAnAwkwardPath(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, `re:po "quoted"`))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt", "two.txt")
	testSquash(t, repo, "topic")
	if w := testTree(t, testScan(t, root), topic); !w.Recommended {
		t.Fatalf("the squash was not found: merged=%v reason=%q problems=%v", w.Merged, w.MergeReason, w.Problems)
	}
}

// Removal looks again, and a squashed branch is still a recommendation then.
func TestSquashedWorktreeIsRemovedAsARecommendation(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt", "two.txt")
	testSquash(t, repo, "topic")
	w := testTree(t, testScan(t, root), topic)
	if result, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err != nil || !result.Removed {
		t.Fatalf("removal: %+v, %v", result, err)
	}
	if _, err := os.Stat(topic); !os.IsNotExist(err) {
		t.Fatalf("the worktree is still there: %v", err)
	}
	if head := testGit(t, repo, "rev-parse", "refs/heads/topic"); head != w.Head {
		t.Fatalf("the branch moved or went: %s", head)
	}
}

// A merge made on the branch can hold changes of its own. Its other commits
// being in the default branch says nothing about those.
func TestChangesMadeInAMergeAreNotPassedOver(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt")
	side := testTopic(t, repo, filepath.Join(root, "side"), "side", "side.txt")
	_ = side
	testGit(t, topic, "merge", "--no-commit", "--no-ff", "side")
	testWrite(t, filepath.Join(topic, "only-in-the-merge.txt"), "unique\n")
	testGit(t, topic, "add", "only-in-the-merge.txt")
	testGit(t, topic, "commit", "-m", "Merge side, and more")
	testGit(t, repo, "commit", "--allow-empty", "-m", "Meanwhile")
	testGit(t, repo, "cherry-pick", "topic^1", "side")
	if _, err := os.Stat(filepath.Join(repo, "only-in-the-merge.txt")); err == nil {
		t.Fatal("the fixture put the merge's own change in the default branch")
	}
	if w := testTree(t, testScan(t, root), topic); w.Merged || w.Recommended {
		t.Fatalf("a branch whose merge holds work of its own counts as merged: %q", w.MergeReason)
	}
}

// Patch IDs pass over white space, and white space can be the whole of a
// difference. A match is only a match when it is exact.
func TestChangesThatDifferOnlyInWhiteSpaceAreNotTheSame(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	for _, name := range []string{"copy", "squash"} {
		topic := testLinked(t, repo, filepath.Join(root, name), name)
		testWrite(t, filepath.Join(topic, name+".py"), "if False:\n    print('conditional')\n    print('work')\n")
		testGit(t, topic, "add", ".")
		testGit(t, topic, "commit", "-m", "Guarded")
		if name == "squash" {
			testWrite(t, filepath.Join(topic, "more.txt"), "more\n")
			testGit(t, topic, "add", ".")
			testGit(t, topic, "commit", "-m", "More")
		}
	}
	// The default branch has the same lines, with one of them outside the guard.
	testWrite(t, filepath.Join(repo, "copy.py"), "if False:\n    print('conditional')\nprint('work')\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "Guarded")
	testWrite(t, filepath.Join(repo, "squash.py"), "if False:\n    print('conditional')\nprint('work')\n")
	testWrite(t, filepath.Join(repo, "more.txt"), "more\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "Guarded, and more")
	report := testScan(t, root)
	for _, name := range []string{"copy", "squash"} {
		if w := testTree(t, report, filepath.Join(root, name)); w.Merged || w.Recommended {
			t.Fatalf("%s: a change that differs in its indentation counts as the same: %q", name, w.MergeReason)
		}
	}
}

// A commit that changes nothing is the same as every other that changes
// nothing, which says nothing about where a branch's work is.
func TestEmptyCommitsAreNotEvidence(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testLinked(t, repo, filepath.Join(root, "topic"), "topic")
	testGit(t, topic, "commit", "--allow-empty", "-m", "Nothing here")
	testGit(t, repo, "commit", "--allow-empty", "-m", "Nothing there")
	if w := testTree(t, testScan(t, root), topic); w.Merged || w.Recommended {
		t.Fatalf("an empty commit was matched with another: %q", w.MergeReason)
	}
}

// A remote that promises file contents later marks a partial clone, however
// else the repository is marked. Comparing there would fetch.
func TestARemoteThatPromisesContentsMarksAPartialClone(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	if partialClone(context.Background(), repo) {
		t.Fatal("an ordinary repository was taken for a partial clone")
	}
	testGit(t, repo, "remote", "add", "origin", filepath.Join(root, "elsewhere"))
	testGit(t, repo, "config", "remote.origin.promisor", "true")
	if !partialClone(context.Background(), repo) {
		t.Fatal("a promisor remote was not noticed")
	}
}

// Whatever is made for the comparison is gone afterwards, including when
// the comparison could not be finished.
func TestNothingIsLeftBehindWhenComparingFails(t *testing.T) {
	root := t.TempDir()
	scratch := t.TempDir()
	t.Setenv("TMPDIR", scratch)
	repo := testRepo(t, filepath.Join(root, "repo"))
	topic := testTopic(t, repo, filepath.Join(root, "topic"), "topic", "one.txt", "two.txt")
	testSquash(t, repo, "topic")
	w := testTree(t, testScan(t, root), topic)
	// Given a tree where the commit the branch left from should be, the
	// changes can be told apart but no commit can be made of them: the
	// comparison fails after its folder has been made.
	notACommit := testGit(t, repo, "rev-parse", "HEAD~1^{tree}")
	if found := squashed(context.Background(), &w, notACommit, testGit(t, topic, "rev-parse", "HEAD^{tree}")); found != "" {
		t.Fatalf("a comparison that could not be made found %q", found)
	}
	if left, _ := os.ReadDir(scratch); len(left) != 0 {
		t.Fatalf("%d things were left behind", len(left))
	}
}
