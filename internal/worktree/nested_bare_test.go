package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNestedBareRepositoryBlocksExplicitAndRecommendedDeletion(t *testing.T) {
	for _, kind := range []string{"untracked", "ignored", "newline"} {
		t.Run(kind, func(t *testing.T) {
			root := canonicalFixtureDir(t)
			repo := testRepo(t, filepath.Join(root, "repo"))
			checkout := testLinked(t, repo, filepath.Join(root, "session"), "session")
			before := testTree(t, testScan(t, root), checkout)
			parent := checkout
			if kind == "ignored" {
				parent = filepath.Join(checkout, "ignored")
			}
			if err := os.MkdirAll(parent, 0700); err != nil {
				t.Fatal(err)
			}
			nested := filepath.Join(parent, "independent.git")
			if kind == "newline" {
				nested += "\n"
			}
			testGit(t, parent, "clone", "--bare", repo, nested)
			heldCommit := testGit(t, nested, "rev-parse", "HEAD")
			full := testScan(t, root)
			if !testTree(t, full, nested).Bare {
				t.Fatal("discovery missed nested bare repository")
			}
			report, err := Scan(context.Background(), Options{Root: checkout, TargetOnly: true, LinkedOnly: true})
			if err != nil || len(report.Worktrees) != 1 {
				t.Fatalf("target inspection: %+v, %v", report, err)
			}
			w := report.Worktrees[0]
			if w.CanRemove || w.CanDiscard || w.Recommended || !strings.Contains(strings.Join(w.Blockers, " "), "nested") {
				t.Fatalf("nested bare data offered for deletion: %+v", w)
			}
			for _, options := range []RemovalOptions{{ExpectedHead: before.Head, DiscardLocal: true}, {ExpectedHead: before.Head, RecommendedOnly: true}} {
				if _, err := RemoveWorktree(context.Background(), before, options); err == nil {
					t.Fatal("fresh deletion check ignored newly nested bare repository")
				}
			}
			if got := testGit(t, nested, "rev-parse", "HEAD"); got != heldCommit {
				t.Fatal("nested committed work lost")
			}
			if _, err := os.Stat(filepath.Join(checkout, "tracked.txt")); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBareMarkerLookalikesDoNotBlockManualCleanup(t *testing.T) {
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	checkout := testLinked(t, repo, filepath.Join(root, "session"), "session")
	lookalike := filepath.Join(checkout, "ordinary-data")
	if err := os.MkdirAll(filepath.Join(lookalike, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(lookalike, "HEAD"), "not a Git reference\n")
	testWrite(t, filepath.Join(lookalike, "objects", "payload"), "ordinary disposable output\n")
	w := testTree(t, testScan(t, root), checkout)
	if !w.CanDiscard || strings.Contains(strings.Join(w.Blockers, " "), "nested") {
		t.Fatalf("lookalikes classified as repository: %+v", w)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true}); err != nil {
		t.Fatal(err)
	}
}
