package worktree

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveMergedTreeRetainsBranch(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "finished-topic")
	w := testTree(t, testScan(t, root), wt)
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("tree directory remains or unexpected stat error: %v", err)
	}
	if got := testGit(t, repo, "rev-parse", "refs/heads/finished-topic"); got != w.Head {
		t.Fatalf("branch was deleted or changed: %s", got)
	}
	if trees := parseList(testGit(t, repo, "worktree", "list", "--porcelain", "-z")); len(trees) != 1 {
		t.Fatalf("worktree metadata was not removed: %+v", trees)
	}
}

func TestRemoveRejectsChangesAfterScan(t *testing.T) {
	cases := []struct {
		name   string
		change func(*testing.T, string, string)
	}{
		{"new commit", func(t *testing.T, repo, wt string) {
			testWrite(t, filepath.Join(wt, "tracked.txt"), "new\n")
			testGit(t, wt, "commit", "-am", "Commit after scan")
		}},
		{"tracked edit", func(t *testing.T, repo, wt string) { testWrite(t, filepath.Join(wt, "tracked.txt"), "unsaved\n") }},
		{"untracked file", func(t *testing.T, repo, wt string) { testWrite(t, filepath.Join(wt, "local.txt"), "keep\n") }},
		{"ignored file", func(t *testing.T, repo, wt string) {
			if err := os.Mkdir(filepath.Join(wt, "ignored"), 0700); err != nil {
				t.Fatal(err)
			}
			testWrite(t, filepath.Join(wt, "ignored", "secret"), "keep\n")
		}},
		{"lock", func(t *testing.T, repo, wt string) { testGit(t, repo, "worktree", "lock", wt) }},
		{"detached head", func(t *testing.T, repo, wt string) { testGit(t, wt, "checkout", "--detach") }},
		{"branch switched at same commit", func(t *testing.T, repo, wt string) { testGit(t, wt, "checkout", "-b", "replacement-topic") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			w := testTree(t, testScan(t, root), wt)
			if !w.Recommended {
				t.Fatalf("expected clean recommended snapshot: %+v", w)
			}
			tc.change(t, repo, wt)
			if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
				t.Fatal("removal accepted stale snapshot")
			}
			if _, err := os.Stat(wt); err != nil {
				t.Fatalf("tree must remain intact: %v", err)
			}
		})
	}
}

func TestRemoveRechecksMergeDestination(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	w := testTree(t, testScan(t, root), wt)
	if !w.Recommended {
		t.Fatal("fixture must begin recommended")
	}
	// Simulate a rewritten default branch after the scan without changing the
	// candidate's commit or clean working directory.
	testGit(t, repo, "checkout", "--orphan", "new-history")
	testGit(t, repo, "commit", "-m", "Independent history")
	testGit(t, repo, "update-ref", "refs/heads/main", "HEAD")
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
		t.Fatal("cleanup trusted stale merge status")
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatalf("worktree should remain: %v", err)
	}
}

func TestRemoveRejectsWrongOrEmptyExpectedHead(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	w := testTree(t, testScan(t, root), wt)
	for _, head := range []string{"", "0000000000000000000000000000000000000000"} {
		if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: head}); err == nil {
			t.Fatalf("expected head %q accepted", head)
		}
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveRecommendedOnlyRejectsUnmergedTree(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "unmerged\n")
	testGit(t, wt, "commit", "-am", "Unmerged commit")
	w := testTree(t, testScan(t, root), wt)
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
		t.Fatal("cleanup removed an unmerged tree")
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head}); err != nil {
		t.Fatalf("explicit clean removal failed: %v", err)
	}
	if got := testGit(t, repo, "rev-parse", "refs/heads/topic"); got != w.Head {
		t.Fatal("explicit removal did not preserve branch")
	}
}

func TestRemoveRefusesPrimaryAndOutsideRoot(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	outside := testLinked(t, repo, filepath.Join(t.TempDir(), "outside"), "outside")
	report := testScan(t, root)
	for _, p := range []string{repo, outside} {
		w := testTree(t, report, p)
		if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head}); err == nil {
			t.Fatalf("protected tree %s was removed", p)
		}
		if _, err := os.Stat(p); err != nil {
			t.Fatal(err)
		}
	}
}
