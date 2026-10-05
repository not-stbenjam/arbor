package worktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A submodule the index names but that is not checked out puts nothing in
// the folder, and Git removes such a worktree without being forced. What is
// in the index is still seen: here, the staged addition itself.
func TestCombinedIndexInspectionReadsSubmoduleEntries(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	linked := testLinked(t, repo, filepath.Join(root, "linked"), "feature")
	head := testGit(t, repo, "rev-parse", "HEAD")
	testGit(t, linked, "update-index", "--add", "--cacheinfo", "160000,"+head+",modules/dependency")
	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	w := testTree(t, report, linked)
	assertProtected(t, w, "Uncommitted")
	if len(w.Blockers) != 1 {
		t.Fatalf("a submodule that is not checked out was held against the worktree: %v", w.Blockers)
	}
	// Something in that folder is another matter: Git does not look inside.
	if err := os.MkdirAll(filepath.Join(linked, "modules", "dependency"), 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(linked, "modules", "dependency", "notes.txt"), "kept nowhere else\n")
	report, err = Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	assertProtected(t, testTree(t, report, linked), "Unchecked files")
}

func TestBatchedMetadataInspectionFindsAllOperations(t *testing.T) {
	for _, name := range []string{"rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			linked := testLinked(t, repo, filepath.Join(root, "linked"), "feature")
			path := testGit(t, linked, "rev-parse", "--path-format=absolute", "--git-path", name)
			if name == "rebase-merge" || name == "rebase-apply" || name == "sequencer" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				testWrite(t, path, testGit(t, linked, "rev-parse", "HEAD")+"\n")
			}
			report, err := Scan(context.Background(), Options{Root: linked, TargetOnly: true})
			if err != nil {
				t.Fatal(err)
			}
			assertProtected(t, testTree(t, report, linked), "Unfinished Git operation")
		})
	}
}

func TestRemovalDoesNotReuseScanDefaultRefCache(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	linked := testLinked(t, repo, filepath.Join(root, "linked"), "finished")
	w := testTree(t, testScan(t, root), linked)
	if !w.Recommended {
		t.Fatal("fixture was not initially merged")
	}
	// A newly available remote default branch is unrelated to the old one.
	tree := testGit(t, repo, "rev-parse", "HEAD^{tree}")
	newDefault := testGit(t, repo, "commit-tree", tree, "-m", "Unrelated history")
	testGit(t, repo, "update-ref", "refs/remotes/origin/main", newDefault)
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
		t.Fatal("cleanup reused old default-ref cache after refs changed")
	}
	if _, err := os.Stat(linked); err != nil {
		t.Fatal("ref-changed worktree was removed")
	}
}

func TestDiscoveryDoesNotSkipNestedRepoUnderFalseBareMarkers(t *testing.T) {
	root := t.TempDir()
	lookalike := filepath.Join(root, "not-bare")
	if err := os.MkdirAll(filepath.Join(lookalike, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(lookalike, "HEAD"), "not a Git reference\n")
	nested := testRepo(t, filepath.Join(lookalike, "objects", "nested-repository"))
	report := testScan(t, root)
	if len(report.Worktrees) != 1 {
		t.Fatalf("false bare markers altered discovery: %+v", report)
	}
	testTree(t, report, nested)
}

func TestDiscoveryDoesNotFollowDirectorySymlinks(t *testing.T) {
	root := t.TempDir()
	outside := testRepo(t, filepath.Join(t.TempDir(), "outside"))
	if err := os.Symlink(outside, filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	report := testScan(t, root)
	if len(report.Worktrees) != 0 {
		t.Fatalf("discovery followed an out-of-scope symlink: %+v", report)
	}
}

func TestDiscoveryCancellationFromProgressStopsTraversal(t *testing.T) {
	root := t.TempDir()
	testRepo(t, filepath.Join(root, "repo"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, _, err := discover(ctx, root, func(string) bool { return false }, func(event Progress) {
		if event.Worktree != nil {
			t.Error("continued discovery after cancellation")
		}
		cancel()
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("discovery didn't propagate cancellation: %v", err)
	}
}
