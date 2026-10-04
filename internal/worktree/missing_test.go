package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Resolve aliases while the temporary directory still exists. Once a checkout
// is moved or removed, EvalSymlinks(target) cannot recover its canonical prefix
// (notably /var -> /private/var on macOS).
func canonicalFixtureDir(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func moveFixtureCheckout(t *testing.T, path string) string {
	t.Helper()
	saved := path + "-saved"
	if err := os.Rename(path, saved); err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestRemoveOneMissingRegistrationKeepsOtherEntriesAndBranches(t *testing.T) {
	for _, locked := range []bool{false, true} {
		t.Run(map[bool]string{false: "unlocked", true: "locked"}[locked], func(t *testing.T) {
			root := canonicalFixtureDir(t)
			repo := testRepo(t, filepath.Join(root, "repo"))
			target := testLinked(t, repo, filepath.Join(root, "gone"), "gone-topic")
			other := testLinked(t, repo, filepath.Join(canonicalFixtureDir(t), "other-gone"), "other-topic")
			if locked {
				testGit(t, repo, "worktree", "lock", "--reason", "offline", target)
			}
			saved := moveFixtureCheckout(t, target)
			moveFixtureCheckout(t, other)
			w := testTree(t, testScan(t, root), target)
			if !w.Missing || !w.CanDiscard || w.CanRemove || w.Recommended || w.SizeBytes != 0 {
				t.Fatalf("wrong missing registration policy: %+v", w)
			}
			if err := Remove(context.Background(), w, w.Head, false); err == nil {
				t.Fatal("missing registration accepted without explicit force")
			}
			targeted, err := Scan(context.Background(), Options{Root: target, Repository: w.CommonDir, TargetOnly: true, LinkedOnly: true})
			if err != nil {
				t.Fatal(err)
			}
			if len(targeted.Worktrees) != 1 || targeted.Worktrees[0].ID != w.ID {
				t.Fatalf("target lookup changed identity: %+v", targeted)
			}
			result, err := RemoveWithResult(context.Background(), targeted.Worktrees[0], w.Head, false, true)
			if err != nil || !result.Removed {
				t.Fatalf("target removal: %+v %v", result, err)
			}
			entries := parseList(testGit(t, repo, "worktree", "list", "--porcelain", "-z"))
			if len(entries) != 2 || entries[1].Path != other {
				t.Fatalf("unrelated registration changed: %+v", entries)
			}
			if got := testGit(t, repo, "rev-parse", "refs/heads/gone-topic"); got != w.Head {
				t.Fatal("branch lost")
			}
			if _, err := os.Stat(filepath.Join(saved, "tracked.txt")); err != nil {
				t.Fatal("moved checkout contents were touched:", err)
			}
		})
	}
}

func TestMissingTargetFindsOnlyNearestAncestorRepository(t *testing.T) {
	repo := testRepo(t, filepath.Join(canonicalFixtureDir(t), "repo"))
	target := testLinked(t, repo, filepath.Join(repo, ".claude", "worktrees", "topic"), "topic")
	moveFixtureCheckout(t, target)
	report, err := Scan(context.Background(), Options{Root: target, TargetOnly: true, LinkedOnly: true})
	if err != nil || len(report.Worktrees) != 1 || !report.Worktrees[0].Missing {
		t.Fatalf("ancestor lookup: %+v %v", report, err)
	}
	unrelated := filepath.Join(canonicalFixtureDir(t), "missing")
	if _, err := Scan(context.Background(), Options{Root: unrelated, TargetOnly: true}); err == nil || !strings.Contains(err.Error(), "--repo") {
		t.Fatalf("unrelated missing path should require repository hint: %v", err)
	}
	wrong := testRepo(t, filepath.Join(canonicalFixtureDir(t), "other-repo"))
	report, err = Scan(context.Background(), Options{Root: target, Repository: wrong, TargetOnly: true})
	if err != nil || len(report.Worktrees) != 0 {
		t.Fatalf("wrong repository authorized target: %+v %v", report, err)
	}
}

func TestMissingDetachedRegistrationPreservesUniqueCommit(t *testing.T) {
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	target := testLinked(t, repo, filepath.Join(root, "detached"), "topic")
	testGit(t, target, "checkout", "--detach")
	testWrite(t, filepath.Join(target, "tracked.txt"), "unique detached work\n")
	testGit(t, target, "commit", "-am", "Unique detached work")
	moveFixtureCheckout(t, target)
	w := testTree(t, testScan(t, root), target)
	if !w.CanDiscard || !w.Missing || !w.Detached {
		t.Fatalf("policy: %+v", w)
	}
	result, err := RemoveWithResult(context.Background(), w, w.Head, false, true)
	if err != nil || result.RetainedBranch == "" {
		t.Fatalf("retention: %+v %v", result, err)
	}
	if got := testGit(t, repo, "rev-parse", "refs/heads/"+result.RetainedBranch); got != w.Head {
		t.Fatal("unique detached commit lost")
	}
}

func TestMissingRegistrationRejectsReplacedPathsAndStaleHeads(t *testing.T) {
	for _, kind := range []string{"directory", "symlink", "dangling-symlink", "parent-symlink", "head"} {
		t.Run(kind, func(t *testing.T) {
			root := canonicalFixtureDir(t)
			repo := testRepo(t, filepath.Join(root, "repo"))
			parent := filepath.Join(root, "sessions")
			target := testLinked(t, repo, filepath.Join(parent, "topic"), "topic")
			moveFixtureCheckout(t, target)
			w := testTree(t, testScan(t, root), target)
			other := canonicalFixtureDir(t)
			switch kind {
			case "directory":
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
				testWrite(t, filepath.Join(target, "keep.txt"), "not the original checkout")
			case "symlink":
				if err := os.Symlink(other, target); err != nil {
					t.Fatal(err)
				}
			case "dangling-symlink":
				if err := os.Symlink(filepath.Join(other, "absent"), target); err != nil {
					t.Fatal(err)
				}
			case "parent-symlink":
				if err := os.Rename(parent, parent+"-saved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(other, parent); err != nil {
					t.Fatal(err)
				}
			case "head":
				testWrite(t, filepath.Join(repo, "tracked.txt"), "new commit\n")
				testGit(t, repo, "commit", "-am", "Move branch")
				testGit(t, repo, "update-ref", "refs/heads/topic", "HEAD")
			}
			if err := RemoveWithOptions(context.Background(), w, w.Head, false, true); err == nil {
				t.Fatal("changed target accepted")
			}
			if entries := parseList(testGit(t, repo, "worktree", "list", "--porcelain", "-z")); len(entries) != 2 {
				t.Fatalf("registration deleted: %+v", entries)
			}
		})
	}
}

func TestEmptyLinkedCheckoutIsRemovable(t *testing.T) {
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	target := testLinked(t, repo, filepath.Join(root, "empty"), "empty-topic")
	testGit(t, target, "rm", "--", "tracked.txt", ".gitignore")
	testGit(t, target, "commit", "-m", "Empty checkout")
	w := testTree(t, testScan(t, root), target)
	if w.SizeBytes != 0 || w.Missing || !w.CanRemove {
		t.Fatalf("empty checkout misclassified: %+v", w)
	}
	if err := Remove(context.Background(), w, w.Head, false); err != nil {
		t.Fatal(err)
	}
	if got := testGit(t, repo, "rev-parse", "refs/heads/empty-topic"); got != w.Head {
		t.Fatal("empty checkout branch lost")
	}
}

func TestMissingTargetCanonicalizesAnExistingParentAlias(t *testing.T) {
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	parent := filepath.Join(root, "sessions")
	target := testLinked(t, repo, filepath.Join(parent, "topic"), "topic")
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(parent, alias); err != nil {
		t.Fatal(err)
	}
	moveFixtureCheckout(t, target)
	report, err := Scan(context.Background(), Options{Root: filepath.Join(alias, "topic"), Repository: repo, TargetOnly: true, LinkedOnly: true})
	if err != nil || len(report.Worktrees) != 1 || report.Root != target || report.Worktrees[0].Path != target {
		t.Fatalf("parent alias was not canonicalized: %+v %v", report, err)
	}
	w := report.Worktrees[0]
	if err := RemoveWithOptions(context.Background(), w, w.Head, false, true); err != nil {
		t.Fatal(err)
	}
}
