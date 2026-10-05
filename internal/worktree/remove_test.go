package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// testChangeDuringRemoval stands in for a concurrent editor or agent. It runs
// a shell action exactly once, late in removal's own inspection, and then the
// Git command that was requested. It returns a file the action creates.
func testChangeDuringRemoval(t *testing.T, worktree, action string) string {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	marker := filepath.Join(bin, "changed")
	script := `#!/bin/sh
case " $* " in *" merge-base "*)
	if [ ! -e "$ARBOR_TEST_MARKER" ]; then
		: > "$ARBOR_TEST_MARKER"
		( ` + action + ` ) || exit 97
	fi ;;
esac
exec "$ARBOR_TEST_GIT" "$@"
`
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ARBOR_TEST_GIT", real)
	t.Setenv("ARBOR_TEST_MARKER", marker)
	t.Setenv("ARBOR_TEST_WORKTREE", worktree)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return marker
}

// Removal inspects files, refs, and optionally GitHub after reading HEAD. Git
// removes a clean detached checkout without complaint, so a commit made on a
// HEAD that detached during that inspection would be lost with the folder.
func TestRemoveRechecksIdentityAfterInspection(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	w := testTree(t, testScan(t, root), wt)
	if !w.Recommended {
		t.Fatalf("fixture must begin recommended: %+v", w)
	}
	marker := testChangeDuringRemoval(t, wt, `"$ARBOR_TEST_GIT" -C "$ARBOR_TEST_WORKTREE" checkout --quiet --detach &&
		"$ARBOR_TEST_GIT" -C "$ARBOR_TEST_WORKTREE" -c user.name=Arbor -c user.email=arbor@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet --allow-empty -m "Commit during validation"`)
	_, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true})
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Fatalf("fixture never moved the checkout: %v (removal: %v)", statErr, err)
	}
	if err == nil || !strings.Contains(err.Error(), "changed during validation") {
		t.Fatalf("removal accepted a checkout that moved during validation: %v", err)
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatalf("moved checkout must remain: %v", err)
	}
	if head := testGit(t, repo, "-C", wt, "rev-parse", "HEAD"); head == w.Head {
		t.Fatal("fixture did not create the commit the check must protect")
	}
}

// A folder swapped into the checkout's place can keep its Git pointer, so Git
// still accepts it as this worktree. Consent to discard the inspected folder's
// files is not consent to delete a different folder's.
func TestRemoveRejectsDirectoryReplacedDuringInspection(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "scratch.txt"), "disposable\n")
	w := testTree(t, testScan(t, root), wt)
	if w.CanRemove || !w.CanDiscard {
		t.Fatalf("fixture must need explicit disposal: %+v", w)
	}
	marker := testChangeDuringRemoval(t, wt, `mv "$ARBOR_TEST_WORKTREE" "$ARBOR_TEST_WORKTREE-original" &&
		mkdir "$ARBOR_TEST_WORKTREE" &&
		cp "$ARBOR_TEST_WORKTREE-original/.git" "$ARBOR_TEST_WORKTREE/.git" &&
		echo unrelated > "$ARBOR_TEST_WORKTREE/unrelated.txt"`)
	_, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true})
	if _, statErr := os.Stat(marker); statErr != nil {
		t.Fatalf("fixture never replaced the checkout: %v (removal: %v)", statErr, err)
	}
	if err == nil || !strings.Contains(err.Error(), "replaced during validation") {
		t.Fatalf("removal accepted a replaced directory: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(wt, "unrelated.txt")); err != nil || string(got) != "unrelated\n" {
		t.Fatalf("replacement folder's files were deleted: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(wt+"-original", "scratch.txt")); err != nil {
		t.Fatalf("original checkout changed: %v", err)
	}
}

// Whitespace is a legal part of a directory name. Removal must compare the
// repository it finds with the one the scan recorded, byte for byte.
func TestRemoveAcceptsRepositoryPathEndingInWhitespace(t *testing.T) {
	root := t.TempDir()
	source := testRepo(t, filepath.Join(t.TempDir(), "source"))
	bare := filepath.Join(root, "storage.git ")
	testGit(t, root, "clone", "--bare", source, bare)
	wt := testLinked(t, bare, filepath.Join(root, "checkout"), "topic")
	w := testTree(t, testScan(t, root), wt)
	if !w.Recommended || !strings.HasSuffix(w.CommonDir, " ") {
		t.Fatalf("fixture must be recommended with its exact repository path: %+v", w)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err != nil {
		t.Fatalf("unchanged repository refused: %v", err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("checkout remains: %v", err)
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
