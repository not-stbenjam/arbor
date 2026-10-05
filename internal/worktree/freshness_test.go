package worktree

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// A branch that still points at its starting commit is trivially an ancestor
// of the default branch. That must not make a checkout someone just created
// eligible for one-click cleanup.
func TestNewUnusedWorktreeIsNotRecommended(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	created := testNewLinked(t, repo, filepath.Join(root, "created"), "new-session")
	established := testLinked(t, repo, filepath.Join(root, "established"), "old-session")
	report := testScan(t, root)
	w := testTree(t, report, created)
	if !w.Fresh || !w.Merged || w.Recommended || !w.CanRemove || len(w.Blockers) != 0 {
		t.Fatalf("new checkout must stay removable but not recommended: %+v", w)
	}
	if old := testTree(t, report, established); old.Fresh || !old.Recommended {
		t.Fatalf("established unused checkout should be recommended: %+v", old)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
		t.Fatal("recommended cleanup removed a checkout created moments ago")
	}
	if _, err := os.Stat(created); err != nil {
		t.Fatalf("new checkout must remain: %v", err)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head}); err != nil {
		t.Fatalf("explicit removal of a new checkout refused: %v", err)
	}
}

func TestNewWorktreeWithMergedWorkIsRecommended(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testNewLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "finished\n")
	testGit(t, wt, "commit", "-am", "Finish topic")
	testGit(t, repo, "merge", "--no-ff", "-m", "Merge topic", "topic")
	// Same-day work that was committed here and merged is finished, not new.
	if w := testTree(t, testScan(t, root), wt); w.Fresh || !w.Merged || !w.Recommended {
		t.Fatalf("merged work in a recent checkout should be recommended: %+v", w)
	}
}

func TestWorktreeWithoutCreationEvidenceIsNotFresh(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := filepath.Join(root, "linked")
	testGit(t, repo, "-c", "core.logAllRefUpdates=false", "worktree", "add", "-b", "topic", wt)
	if w := testTree(t, testScan(t, root), wt); w.Fresh || !w.Recommended {
		t.Fatalf("age is unknown without a HEAD reflog: %+v", w)
	}
}
