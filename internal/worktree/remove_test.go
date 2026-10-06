package worktree

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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
	return testChangeAtGitCall(t, worktree, "merge-base", 1, action)
}

// testChangeAtGitCall runs a shell action exactly once, just before the nth
// Git command whose arguments include the given word.
func testChangeAtGitCall(t *testing.T, worktree, word string, nth int, action string) string {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	marker := filepath.Join(bin, "changed")
	script := `#!/bin/sh
case " $* " in *" ` + word + ` "*)
	printf x >> "$ARBOR_TEST_MARKER.calls"
	if [ ! -e "$ARBOR_TEST_MARKER" ] && [ "$(wc -c < "$ARBOR_TEST_MARKER.calls" | tr -d '[:space:]')" -ge ` + strconv.Itoa(nth) + ` ]; then
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

// While a folder is deleted, the watcher says how many of its files are gone
// and names one that is going. It is driven here by deleting in steps, since
// how fast Git deletes is not something a test can hold still.
func TestRemovalIsReportedFileByFile(t *testing.T) {
	tick, count := removalTick, removalCount
	removalTick, removalCount = 2*time.Millisecond, 4*time.Millisecond
	t.Cleanup(func() { removalTick, removalCount = tick, count })

	root := t.TempDir()
	var files []string
	for _, dir := range []string{"a", "b/deep"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 10; i++ {
			path := filepath.Join(root, dir, fmt.Sprintf("file-%02d", i))
			testWrite(t, path, "x")
			files = append(files, path)
		}
	}
	var mu sync.Mutex
	var events []Progress
	seen := func() []Progress {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(events)
	}
	stop := watchRemoval(root, 20, func(event Progress) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	})
	waitFor := func(what string, ok func(Progress) bool) Progress {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if all := seen(); len(all) > 0 && ok(all[len(all)-1]) {
				return all[len(all)-1]
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatalf("no report of %s; got %+v", what, seen())
		return Progress{}
	}
	first := waitFor("the total", func(p Progress) bool { return p.FilesTotal == 20 })
	if first.Stage != "remove" || first.Path != root || first.Files != 0 {
		t.Fatalf("first report: %+v", first)
	}
	// A file that is still there is named, relative to the folder.
	named := waitFor("a file", func(p Progress) bool { return p.Current != "" })
	if _, err := os.Lstat(filepath.Join(root, filepath.FromSlash(named.Current))); err != nil {
		t.Fatalf("named a file that was not there: %q: %v", named.Current, err)
	}
	for _, path := range files[:10] {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	waitFor("half gone", func(p Progress) bool { return p.Files == 10 })
	for _, path := range files[10:15] {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	waitFor("three quarters gone", func(p Progress) bool { return p.Files == 15 })
	stop()
	after := len(seen())
	time.Sleep(4 * removalTick)
	if len(seen()) != after {
		t.Fatal("reports continued after the watcher was stopped")
	}
	// The count never goes backwards and never passes the total.
	last := 0
	for _, event := range seen() {
		if event.Files < last || event.Files > event.FilesTotal || event.FilesTotal != 20 {
			t.Fatalf("report out of order: %+v", seen())
		}
		last = event.Files
	}
	// With nobody to tell, or nothing to delete, there is nothing to watch.
	watchRemoval(root, 20, nil)()
	watchRemoval(filepath.Join(root, "absent"), 0, func(Progress) { t.Error("reported on a folder with nothing in it") })()
}

// The last look through a folder counts what the progress will count down
// from, and finds a repository the inspection did not account for.
func TestSurveyCountsFilesAndFindsRepositories(t *testing.T) {
	// A removal only ever looks through a canonical path.
	root := canonicalFixtureDir(t)
	testWrite(t, filepath.Join(root, ".git"), "gitdir: elsewhere\n")
	testWrite(t, filepath.Join(root, "tracked.txt"), "x")
	for _, dir := range []string{"vendor/library", "src"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	testWrite(t, filepath.Join(root, "src", "main.go"), "x")
	testWrite(t, filepath.Join(root, "vendor", "library", ".git"), "gitdir: elsewhere\n")
	testWrite(t, filepath.Join(root, "vendor", "library", "lib.go"), "x")
	known := []string{filepath.Join(root, "vendor", "library")}
	files, nested, err := survey(context.Background(), root, known)
	if err != nil || files != 5 || nested {
		t.Fatalf("a worktree with its own submodule: %d files, nested=%v, %v", files, nested, err)
	}
	if files != countFiles(root, nil) {
		t.Fatal("the survey and the progress count disagree about what a file is")
	}
	// The same folder, when nothing said it was a submodule.
	if _, nested, _ := survey(context.Background(), root, nil); !nested {
		t.Fatal("a repository nobody accounted for was not found")
	}
	// A repository with a checkout, and one without.
	inner := testRepo(t, filepath.Join(root, "src", "experiment"))
	if files, nested, err := survey(context.Background(), root, known); err != nil || !nested || files != countFiles(root, nil) {
		t.Fatalf("nested repository %s: %d files (%d by count), nested=%v, %v", inner, files, countFiles(root, nil), nested, err)
	}
	if err := os.RemoveAll(inner); err != nil {
		t.Fatal(err)
	}
	testGit(t, root, "init", "--bare", filepath.Join(root, "src", "store"))
	if files, nested, err := survey(context.Background(), root, known); err != nil || !nested || files != countFiles(root, nil) {
		t.Fatalf("a repository without a checkout: %d files (%d by count), nested=%v, %v", files, countFiles(root, nil), nested, err)
	}
}

// Git keeps the repositories of a worktree's submodules beside the
// worktree's other metadata, outside its folder. Commits made in one and
// never pushed exist nowhere else, and go when the worktree does, whether its
// folder is still there or not. That is a loss to be named like any other.
func TestSubmoduleStorageIsALossEvenWithoutTheFolder(t *testing.T) {
	local := []string{"-c", "protocol.file.allow=always"}
	fixture := func(t *testing.T) (root, repo, wt, storage string) {
		// The folder is deleted below, and a path that no longer exists
		// cannot be resolved afterwards to the one a scan reports.
		root = canonicalFixtureDir(t)
		library := testRepo(t, filepath.Join(root, "library"))
		repo = testRepo(t, filepath.Join(root, "repo"))
		testGit(t, repo, append(local, "submodule", "add", library, "vendor/library")...)
		testGit(t, repo, "commit", "-m", "Add the library")
		wt = testLinked(t, repo, filepath.Join(root, "linked"), "topic")
		storage = testGit(t, wt, "rev-parse", "--path-format=absolute", "--git-path", "modules")
		return root, repo, wt, storage
	}
	t.Run("the folder is gone but a submodule's repository was left behind", func(t *testing.T) {
		root, repo, wt, storage := fixture(t)
		testGit(t, wt, append(local, "submodule", "update", "--init")...)
		if err := os.RemoveAll(wt); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(storage); err != nil {
			t.Fatalf("fixture: no submodule storage at %s: %v", storage, err)
		}
		w := testTree(t, testScan(t, root), wt)
		if !w.Missing || w.CanRemove || !w.CanDiscard || !slices.Equal(w.Losses, []string{"submodules"}) {
			t.Fatalf("a missing worktree with submodule storage: %+v", w)
		}
		if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true}); err == nil || !strings.Contains(err.Error(), "submodule checkouts") {
			t.Fatalf("a submodule's repository went with the registration unnamed: %v", err)
		}
		if _, err := os.Stat(storage); err != nil {
			t.Fatal("the submodule storage was deleted")
		}
		if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: []string{"submodules"}}); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(testGit(t, repo, "worktree", "list", "--porcelain"), wt) {
			t.Fatal("the registration was not removed")
		}
	})
	t.Run("a submodule's repository appears after the worktree was inspected", func(t *testing.T) {
		root, _, wt, storage := fixture(t)
		testWrite(t, filepath.Join(wt, "scratch.txt"), "disposable\n")
		w := testTree(t, testScan(t, root), wt)
		if !slices.Equal(w.Losses, []string{"changes"}) {
			t.Fatalf("fixture must hold only local files: %+v", w)
		}
		// After the fresh inspection, and before the last look.
		t.Setenv("ARBOR_TEST_STORAGE", storage)
		marker := testChangeAtGitCall(t, wt, "refs/heads/topic", 1, `"$ARBOR_TEST_GIT" init --quiet --bare "$ARBOR_TEST_STORAGE/library"`)
		_, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: []string{"nested", "operation"}})
		if _, statErr := os.Stat(marker); statErr != nil {
			t.Fatalf("fixture never created the storage: %v (removal: %v)", statErr, err)
		}
		if err == nil || !strings.Contains(err.Error(), "submodule checkouts") {
			t.Fatalf("a submodule's repository nobody was shown went with the folder: %v", err)
		}
		if _, err := os.Stat(filepath.Join(storage, "library", "HEAD")); err != nil {
			t.Fatalf("the submodule storage was deleted: %v", err)
		}
	})
}

// What was agreed to is what was shown. Something graver than files that
// arrives after the worktree was inspected stops the deletion, however
// general the agreement to discard local files.
func TestRemoveStopsForAGraveLossThatArrivesLate(t *testing.T) {
	for _, tc := range []struct{ name, action, lost string }{
		{"another repository", `"$ARBOR_TEST_GIT" init --quiet "$ARBOR_TEST_WORKTREE/experiment" &&
			"$ARBOR_TEST_GIT" -C "$ARBOR_TEST_WORKTREE/experiment" -c user.name=Arbor -c user.email=arbor@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet --allow-empty -m "Kept nowhere else"`, "separate Git repository"},
		{"an operation begun since", `"$ARBOR_TEST_GIT" -C "$ARBOR_TEST_WORKTREE" rev-parse HEAD > "$("$ARBOR_TEST_GIT" -C "$ARBOR_TEST_WORKTREE" rev-parse --path-format=absolute --git-path MERGE_HEAD)"`, "unfinished Git operation"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			testWrite(t, filepath.Join(wt, "scratch.txt"), "disposable\n")
			w := testTree(t, testScan(t, root), wt)
			if w.CanRemove || !w.CanDiscard || !slices.Equal(w.Losses, []string{"changes"}) {
				t.Fatalf("fixture must hold only local files: %+v", w)
			}
			marker := testChangeDuringRemoval(t, wt, tc.action)
			_, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true})
			if _, statErr := os.Stat(marker); statErr != nil {
				t.Fatalf("fixture never changed the checkout: %v (removal: %v)", statErr, err)
			}
			if err == nil || !strings.Contains(err.Error(), tc.lost) {
				t.Fatalf("a loss nobody was shown went with the folder: %v", err)
			}
			if _, err := os.Stat(filepath.Join(wt, "scratch.txt")); err != nil {
				t.Fatalf("the worktree must remain: %v", err)
			}
		})
	}
}

// The real removal reports through the same watcher, and still removes.
func TestRemoveWorktreeReportsItsProgress(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	w := testTree(t, testScan(t, root), wt)
	var mu sync.Mutex
	var events []Progress
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, Progress: func(event Progress) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("the worktree was not removed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	// tracked.txt, .gitignore and the worktree's .git file.
	if len(events) == 0 || events[0].Stage != "remove" || events[0].Path != w.Path || events[0].FilesTotal != 3 {
		t.Fatalf("removal was not reported: %+v", events)
	}
}

// The last look through the folder takes time, as the count for the progress
// display did when it came after the final checks. Whatever happens while it
// is under way must still be caught where it can be: it is followed by the
// checks that this is the same folder at the same commit, and it sees what
// arrives in the folders it has yet to enter.
func TestRemoveCatchesWhatChangesDuringTheLastLook(t *testing.T) {
	for _, tc := range []struct{ name, action, refusal, survives string }{
		{"the folder is swapped for another", `mv "$ARBOR_TEST_WORKTREE" "$ARBOR_TEST_WORKTREE-original" &&
			mkdir "$ARBOR_TEST_WORKTREE" &&
			cp "$ARBOR_TEST_WORKTREE-original/.git" "$ARBOR_TEST_WORKTREE/.git" &&
			echo unrelated > "$ARBOR_TEST_WORKTREE/unrelated.txt"`, "", "unrelated.txt"},
		// A walk lists a folder once, when it enters it. What arrives in a
		// folder it has yet to enter is seen; that is as far as a look can go.
		{"a repository arrives further on", `"$ARBOR_TEST_GIT" init --quiet "$ARBOR_TEST_WORKTREE/zz-later/experiment" &&
			"$ARBOR_TEST_GIT" -C "$ARBOR_TEST_WORKTREE/zz-later/experiment" -c user.name=Arbor -c user.email=arbor@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet --allow-empty -m "Kept nowhere else"`, "separate Git repository", "zz-later/experiment/.git"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			// A folder that looks enough like a repository to be asked about
			// each time the worktree is looked through. It is not one.
			decoy := filepath.Join(wt, "a-decoy")
			if err := os.MkdirAll(filepath.Join(decoy, "objects"), 0700); err != nil {
				t.Fatal(err)
			}
			testWrite(t, filepath.Join(decoy, "HEAD"), "not a Git reference\n")
			testWrite(t, filepath.Join(decoy, "objects", "payload"), "ordinary data\n")
			if err := os.Mkdir(filepath.Join(wt, "zz-later"), 0700); err != nil {
				t.Fatal(err)
			}
			w := testTree(t, testScan(t, root), wt)
			if w.CanRemove || !w.CanDiscard || !slices.Equal(w.Losses, []string{"changes"}) {
				t.Fatalf("fixture must hold only local files: %+v", w)
			}
			// The first time it is asked about is the fresh inspection; the
			// second is the last look.
			marker := testChangeAtGitCall(t, wt, "--is-bare-repository", 2, tc.action)
			_, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Progress: func(Progress) {}})
			if _, statErr := os.Stat(marker); statErr != nil {
				t.Fatalf("fixture never changed the checkout: %v (removal: %v)", statErr, err)
			}
			if err == nil || !strings.Contains(err.Error(), tc.refusal) {
				t.Fatalf("removal went ahead after the folder changed under it: %v", err)
			}
			if _, err := os.Stat(filepath.Join(wt, filepath.FromSlash(tc.survives))); err != nil {
				t.Fatalf("what arrived was deleted: %v", err)
			}
		})
	}
}

// A rebase stopped on a conflict keeps what it was doing, and any changes it
// set aside to begin, beside the worktree's other metadata. Deleting the
// folder by hand leaves all of that behind, and removing the registration
// then removes it. That is an unfinished operation, folder or no folder.
func TestUnfinishedOperationIsALossEvenWithoutTheFolder(t *testing.T) {
	// The folder is deleted below, and a path that no longer exists cannot
	// be resolved afterwards to the one a scan reports.
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "topic\n")
	testGit(t, wt, "commit", "-am", "Topic work")
	testWrite(t, filepath.Join(repo, "tracked.txt"), "main\n")
	testGit(t, repo, "commit", "-am", "Main work")
	// Notes that are not committed; the rebase sets them aside to begin.
	testWrite(t, filepath.Join(wt, ".gitignore"), "ignored/\nnotes kept nowhere else\n")
	cmd := exec.Command("git", "-c", "core.hooksPath=/dev/null", "-C", wt, "rebase", "--autostash", "main")
	cmd.Env = append(commandEnv(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("fixture: the rebase should have stopped on a conflict:\n%s", out)
	}
	state := testGit(t, wt, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge")
	if _, err := os.Stat(filepath.Join(state, "autostash")); err != nil {
		t.Fatalf("fixture: the rebase set nothing aside: %v", err)
	}
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	w := testTree(t, testScan(t, root), wt)
	if !w.Missing || w.CanRemove || !w.CanDiscard || !slices.Equal(w.Losses, []string{"operation"}) {
		t.Fatalf("a missing worktree with a rebase under way: %+v", w)
	}
	for _, options := range []RemovalOptions{
		{ExpectedHead: w.Head, DiscardLocal: true},
		{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: []string{"submodules", "nested"}},
	} {
		if _, err := RemoveWorktree(context.Background(), w, options); err == nil || !strings.Contains(err.Error(), "unfinished Git operation") {
			t.Fatalf("an unfinished rebase went with the registration unnamed (%+v): %v", options, err)
		}
	}
	if _, err := os.Stat(filepath.Join(state, "autostash")); err != nil {
		t.Fatal("what the rebase set aside was deleted")
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: []string{"operation"}}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(testGit(t, repo, "worktree", "list", "--porcelain"), wt) {
		t.Fatal("the registration was not removed")
	}
}

// Git forgets a worktree it could only partly delete. One with a folder
// that cannot be emptied is refused whole, before anything is touched.
func TestWorktreeWithAReadOnlyFolderIsRefusedWhole(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("the superuser may change a read-only folder")
	}
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	linked := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	sealedDir := filepath.Join(linked, "ignored", "cache")
	if err := os.MkdirAll(sealedDir, 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(sealedDir, "module.txt"), "kept\n")
	// An empty read-only folder stops nothing: it goes through its parent.
	if err := os.Mkdir(filepath.Join(linked, "ignored", "empty"), 0500); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sealedDir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(sealedDir, 0700) })
	w := testTree(t, testScan(t, root), linked)
	result, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: w.Losses})
	if err == nil || result.Removed || !strings.Contains(err.Error(), "the folder ignored/cache inside it is read-only") {
		t.Fatalf("removal: %+v, %v", result, err)
	}
	if data, _ := os.ReadFile(filepath.Join(sealedDir, "module.txt")); string(data) != "kept\n" {
		t.Fatal("a file was deleted from a worktree that was refused")
	}
	if _, err := os.Stat(filepath.Join(linked, "tracked.txt")); err != nil {
		t.Fatal("the worktree was partly deleted")
	}
	if !strings.Contains(testGit(t, repo, "worktree", "list", "--porcelain"), linked) {
		t.Fatal("Git no longer knows the worktree that was refused")
	}
	// Made writable, it goes.
	if err := os.Chmod(sealedDir, 0700); err != nil {
		t.Fatal(err)
	}
	w = testTree(t, testScan(t, root), linked)
	if result, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: w.Losses}); err != nil || !result.Removed || result.Missing {
		t.Fatalf("removal once writable: %+v, %v", result, err)
	}
}

// Refs under refs/worktree are one worktree's own, and go with it. A commit
// only they point to has nothing else to keep it.
func TestWorktreeWithRefsOfItsOwnIsNotACleanDelete(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	linked := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(linked, "tracked.txt"), "set aside\n")
	testGit(t, linked, "commit", "-am", "Set aside")
	kept := testGit(t, linked, "rev-parse", "HEAD")
	testGit(t, linked, "update-ref", "refs/worktree/aside", kept)
	testGit(t, linked, "reset", "--hard", "main")
	w := testTree(t, testScan(t, root), linked)
	if w.Recommended || w.CanRemove || !w.CanDiscard {
		t.Fatalf("a worktree with refs of its own: %+v", w)
	}
	assertProtected(t, w, "Refs of its own")
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head}); err == nil {
		t.Fatal("removed without being told to discard them")
	}
	if got := testGit(t, linked, "rev-parse", "refs/worktree/aside"); got != kept {
		t.Fatalf("the ref moved: %s", got)
	}
	if result, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true}); err != nil || !result.Removed {
		t.Fatalf("removal once agreed to: %+v, %v", result, err)
	}
}

// A path Arbor cannot write down and read back as the same path is one it
// cannot safely name to Git, so it offers nothing for it.
func TestWorktreeWhosePathIsNotTextIsLeftAlone(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	path := filepath.Join(root, "bad-\xff")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Skip("this filesystem does not take names that are not text")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	testLinked(t, repo, path, "topic")
	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range report.Worktrees {
		if w.Path != path {
			continue
		}
		if w.Recommended || w.CanRemove || w.CanDiscard {
			t.Fatalf("offered for deletion: %+v", w)
		}
		assertProtected(t, w, "Path is not valid text")
		return
	}
	t.Fatalf("not listed: %+v", report.Worktrees)
}

// One worktree named to be removed is the folder at that path, not whatever
// a symbolic link put there leads to.
func TestNamedTargetThatIsASymbolicLinkIsRefused(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	target := testLinked(t, repo, filepath.Join(root, "target"), "target")
	sibling := testLinked(t, repo, filepath.Join(root, "sibling"), "sibling")
	if err := os.Rename(target, target+"-saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, target); err != nil {
		t.Fatal(err)
	}
	_, err := Scan(context.Background(), Options{Root: target, TargetOnly: true})
	if err == nil || !strings.Contains(err.Error(), "is a symbolic link to "+sibling) {
		t.Fatalf("a symbolic link was taken for the worktree it leads to: %v", err)
	}
	// A link on the way to the worktree is only how its folder is reached.
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	report, err := Scan(context.Background(), Options{Root: filepath.Join(alias, "sibling"), TargetOnly: true})
	if err != nil || len(report.Worktrees) != 1 || report.Worktrees[0].Path != sibling {
		t.Fatalf("a worktree reached through a linked folder: %+v, %v", report.Worktrees, err)
	}
}
