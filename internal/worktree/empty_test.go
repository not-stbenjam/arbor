package worktree

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func replaceFixtureWithEmptyDirectory(t *testing.T, target string) {
	t.Helper()
	moveFixtureCheckout(t, target)
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyStaleCheckoutRequiresExplicitRemovalAndKeepsOtherRegistrations(t *testing.T) {
	for _, locked := range []bool{false, true} {
		t.Run(map[bool]string{false: "unlocked", true: "locked"}[locked], func(t *testing.T) {
			root := canonicalFixtureDir(t)
			repo := testRepo(t, filepath.Join(root, "repo"))
			target := testLinked(t, repo, filepath.Join(root, "empty"), "empty-topic")
			other := testLinked(t, repo, filepath.Join(root, "other"), "other-topic")
			if locked {
				testGit(t, repo, "worktree", "lock", target)
			}
			replaceFixtureWithEmptyDirectory(t, target)
			moveFixtureCheckout(t, other)
			report, err := Scan(context.Background(), Options{Root: target, Repository: repo, TargetOnly: true, LinkedOnly: true})
			if err != nil || len(report.Worktrees) != 1 {
				t.Fatalf("target scan: %+v %v", report, err)
			}
			w := report.Worktrees[0]
			if !w.Empty || w.Missing || !w.CanDiscard || w.CanRemove || w.Recommended || w.SizeBytes != 0 {
				t.Fatalf("empty registration classification: %+v", w)
			}
			if err := Remove(context.Background(), w, w.Head, false); err == nil {
				t.Fatal("empty stale checkout accepted without explicit consent")
			}
			if !emptyCheckoutDirectory(target) {
				t.Fatal("refused removal changed empty directory")
			}
			result, err := RemoveWithResult(context.Background(), w, w.Head, false, true)
			if err != nil || !result.Removed {
				t.Fatalf("explicit empty removal failed: %+v %v", result, err)
			}
			if _, err := os.Lstat(target); !os.IsNotExist(err) {
				t.Fatalf("empty directory remains: %v", err)
			}
			entries := parseList(testGit(t, repo, "worktree", "list", "--porcelain", "-z"))
			if len(entries) != 2 || entries[1].Path != other {
				t.Fatalf("unrelated registration touched: %+v", entries)
			}
			if got := testGit(t, repo, "rev-parse", "refs/heads/empty-topic"); got != w.Head {
				t.Fatal("named committed work was lost")
			}
			if _, err := os.Stat(filepath.Join(target+"-saved", "tracked.txt")); err != nil {
				t.Fatalf("saved checkout touched: %v", err)
			}
		})
	}
}

func TestEmptyStaleDetachedCheckoutRetainsUniqueCommit(t *testing.T) {
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	target := testLinked(t, repo, filepath.Join(root, "detached"), "topic")
	testGit(t, target, "checkout", "--detach")
	testWrite(t, filepath.Join(target, "tracked.txt"), "unique detached work\n")
	testGit(t, target, "commit", "-am", "Unique detached work")
	replaceFixtureWithEmptyDirectory(t, target)
	w := testTree(t, testScan(t, root), target)
	result, err := RemoveWithResult(context.Background(), w, w.Head, false, true)
	if err != nil || !result.Removed || result.RetainedBranch == "" {
		t.Fatalf("empty detached retention failed: %+v %v", result, err)
	}
	if got := testGit(t, repo, "rev-parse", "refs/heads/"+result.RetainedBranch); got != w.Head {
		t.Fatal("detached commit was not preserved")
	}
}

func TestEmptyStaleCheckoutRejectsNewFilesAndReplacementPaths(t *testing.T) {
	for _, replacement := range []string{"file-inside", "dotgit", "symlink", "file"} {
		t.Run(replacement, func(t *testing.T) {
			root := canonicalFixtureDir(t)
			repo := testRepo(t, filepath.Join(root, "repo"))
			target := testLinked(t, repo, filepath.Join(root, "empty"), "topic")
			replaceFixtureWithEmptyDirectory(t, target)
			w := testTree(t, testScan(t, root), target)
			switch replacement {
			case "file-inside":
				testWrite(t, filepath.Join(target, "keep.txt"), "new work")
			case "dotgit":
				testWrite(t, filepath.Join(target, ".git"), "not an empty directory")
			case "symlink", "file":
				if err := os.Rename(target, target+"-original-empty"); err != nil {
					t.Fatal(err)
				}
				if replacement == "symlink" {
					if err := os.Symlink(canonicalFixtureDir(t), target); err != nil {
						t.Fatal(err)
					}
				} else {
					testWrite(t, target, "keep this file")
				}
			}
			if _, err := RemoveWithResult(context.Background(), w, w.Head, false, true); err == nil {
				t.Fatal("changed empty directory accepted for deletion")
			}
			if _, err := os.Lstat(target); err != nil {
				t.Fatalf("replacement path was deleted: %v", err)
			}
			if replacement == "file-inside" {
				if got, err := os.ReadFile(filepath.Join(target, "keep.txt")); err != nil || string(got) != "new work" {
					t.Fatalf("new file touched: %q %v", got, err)
				}
			}
			if entries := parseList(testGit(t, repo, "worktree", "list", "--porcelain", "-z")); len(entries) != 2 {
				t.Fatalf("refusal removed registration: %+v", entries)
			}
		})
	}
}

func TestEmptyCheckoutFinalRemovalRejectsChangedIdentityAndContents(t *testing.T) {
	for _, replacement := range []string{"new-file", "new-directory"} {
		t.Run(replacement, func(t *testing.T) {
			target := filepath.Join(canonicalFixtureDir(t), "empty")
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
			original, err := os.Lstat(target)
			if err != nil {
				t.Fatal(err)
			}
			if replacement == "new-file" {
				testWrite(t, filepath.Join(target, "keep.txt"), "new work")
			} else {
				if err := os.Rename(target, target+"-original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := removeEmptyCheckout(target, original); err == nil {
				t.Fatal("changed directory accepted by final nonrecursive removal")
			}
			if _, err := os.Stat(target); err != nil {
				t.Fatalf("changed directory removed: %v", err)
			}
		})
	}
}
