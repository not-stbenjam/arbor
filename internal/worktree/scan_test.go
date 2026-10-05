package worktree

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Each integration test uses repositories entirely inside t.TempDir. No test
// contacts a remote service or relies on the developer's Git identity.
func testGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	return testGitEnv(t, dir, nil, args...)
}

func testGitEnv(t *testing.T, dir string, env []string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", dir}, args...)...)
	cmd.Env = append(append(commandEnv(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null"), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func testWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func testRepo(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, dir, "init", "--initial-branch=main")
	testGit(t, dir, "config", "user.name", "Arbor Test")
	testGit(t, dir, "config", "user.email", "arbor@example.invalid")
	testWrite(t, filepath.Join(dir, "tracked.txt"), "initial\n")
	testWrite(t, filepath.Join(dir, ".gitignore"), "ignored/\n")
	testGit(t, dir, "add", ".")
	testGit(t, dir, "commit", "-m", "Initial tree")
	return dir
}

// testLinked models an established checkout. Git stamps a new worktree's HEAD
// reflog with the committer date, which is how Arbor learns when it was created.
func testLinked(t *testing.T, repo, path, branch string) string {
	t.Helper()
	created := time.Now().Add(-2 * freshGrace).Format(time.RFC3339)
	testGitEnv(t, repo, []string{"GIT_COMMITTER_DATE=" + created}, "worktree", "add", "-b", branch, path)
	return path
}

// testNewLinked creates a checkout now, as a person or coding tool just did.
func testNewLinked(t *testing.T, repo, path, branch string) string {
	t.Helper()
	testGit(t, repo, "worktree", "add", "-b", branch, path)
	return path
}

func testScan(t *testing.T, root string) Report {
	t.Helper()
	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Warnings) != 0 {
		t.Fatalf("scan warnings: %v", report.Warnings)
	}
	return report
}

func testTree(t *testing.T, report Report, path string) Worktree {
	t.Helper()
	canonical, err := filepath.EvalSymlinks(path)
	if err == nil {
		path = canonical
	}
	for _, w := range report.Worktrees {
		if w.Path == path {
			return w
		}
	}
	t.Fatalf("worktree %q missing from %+v", path, report.Worktrees)
	return Worktree{}
}

func assertProtected(t *testing.T, w Worktree, reason string) {
	t.Helper()
	if w.CanRemove || w.Recommended {
		t.Fatalf("protected tree offered for removal: %+v", w)
	}
	if !strings.Contains(strings.Join(w.Blockers, " "), reason) {
		t.Fatalf("missing blocker %q: %v", reason, w.Blockers)
	}
}

func TestParseListPreservesUnusualPaths(t *testing.T) {
	raw := "worktree /a/repo with spaces\x00HEAD abc\x00branch refs/heads/main\x00\x00" +
		"worktree /a/line\nbreak\tand \\\"quotes\" \x00HEAD def\x00branch refs/heads/feature/topic\x00locked reason with spaces\x00\x00" +
		"worktree /a/bare.git\x00bare\x00\x00worktree /a/gone\x00HEAD fed\x00detached\x00prunable gitdir file points to non-existent location\x00\x00"
	got := parseList(raw)
	if len(got) != 4 {
		t.Fatalf("got %d trees: %+v", len(got), got)
	}
	if got[0].Path != "/a/repo with spaces" || got[0].Branch != "main" {
		t.Fatalf("first tree: %+v", got[0])
	}
	if got[1].Path != "/a/line\nbreak\tand \\\"quotes\" " || got[1].Branch != "feature/topic" || !got[1].Locked || got[1].LockReason != "reason with spaces" {
		t.Fatalf("path or metadata changed: %+v", got[1])
	}
	if !got[2].Bare || !got[3].Detached || !got[3].Missing {
		t.Fatalf("flags lost: %+v", got)
	}
}

func TestFailedFetchIsNotReportedAsFresh(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repository"))
	testGit(t, repo, "remote", "add", "origin", filepath.Join(root, "nonexistent-remote.git"))
	report, err := Scan(context.Background(), Options{Root: root, Fetch: true})
	if err != nil {
		t.Fatal(err)
	}
	if report.Fetched {
		t.Fatal("failed fetch must not be presented as current remote evidence")
	}
	if len(report.Warnings) == 0 {
		t.Fatal("failed fetch must be visible to the user")
	}
}

func TestScanDiscoversLinkedNestedAndOutsideTrees(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repository"))
	linked := testLinked(t, repo, filepath.Join(root, "a linked tree"), "topic")
	outside := testLinked(t, repo, filepath.Join(t.TempDir(), "outside"), "outside")
	nested := testRepo(t, filepath.Join(repo, "nested"))
	report := testScan(t, root)
	if len(report.Worktrees) != 4 {
		t.Fatalf("want exactly four deduplicated worktrees; got %d", len(report.Worktrees))
	}
	main := testTree(t, report, repo)
	assertProtected(t, main, "Primary")
	assertProtected(t, main, "nested")
	w := testTree(t, report, linked)
	if w.Main || w.OutsideRoot || !w.Merged || !w.Recommended || !w.CanRemove {
		t.Fatalf("clean merged linked tree: %+v", w)
	}
	if w.Repo != "repository" || w.Branch != "topic" || len(w.Head) != 40 || w.Author != "Arbor Test" || w.Subject != "Initial tree" || w.CommitAt.IsZero() || w.ActivityAt.Before(w.CommitAt) || w.SizeBytes == 0 {
		t.Fatalf("missing metadata: %+v", w)
	}
	if w.ID == "" || w.ID == main.ID || w.CommonDir != main.CommonDir {
		t.Fatalf("incorrect identity: %+v", w)
	}
	assertProtected(t, testTree(t, report, outside), "Outside")
	assertProtected(t, testTree(t, report, nested), "Primary")
	// A linked checkout's .git file must independently lead back to the repo.
	narrow := testScan(t, linked)
	if len(narrow.Worktrees) != 3 {
		t.Fatalf("linked-root discovery: %+v", narrow.Worktrees)
	}
	assertProtected(t, testTree(t, narrow, repo), "Outside")
	if testTree(t, narrow, linked).ID != w.ID {
		t.Fatal("worktree ID changed with scan root")
	}
}

func TestScanBareRepositoryWithLinkedTree(t *testing.T) {
	root := t.TempDir()
	source := testRepo(t, filepath.Join(t.TempDir(), "source"))
	bare := filepath.Join(root, "storage.git")
	testGit(t, root, "clone", "--bare", source, bare)
	linked := testLinked(t, bare, filepath.Join(root, "checkout"), "topic")
	report := testScan(t, root)
	if len(report.Worktrees) != 2 {
		t.Fatalf("bare discovery: %+v", report.Worktrees)
	}
	b := testTree(t, report, bare)
	if !b.Bare || !b.Main || b.Repo != "storage" {
		t.Fatalf("bare metadata: %+v", b)
	}
	assertProtected(t, b, "Bare")
	w := testTree(t, report, linked)
	if w.Main || w.Bare || w.Repo != "storage" || !w.Recommended {
		t.Fatalf("bare linked metadata: %+v", w)
	}
}

func TestScanDeletionBlockers(t *testing.T) {
	cases := []struct {
		name, reason string
		change       func(*testing.T, string, string)
	}{
		{"tracked edits", "Uncommitted", func(t *testing.T, repo, wt string) { testWrite(t, filepath.Join(wt, "tracked.txt"), "changed\n") }},
		{"untracked file", "Uncommitted", func(t *testing.T, repo, wt string) {
			testWrite(t, filepath.Join(wt, "local secret"), "do not delete\n")
		}},
		{"ignored file", "Ignored", func(t *testing.T, repo, wt string) {
			if err := os.Mkdir(filepath.Join(wt, "ignored"), 0700); err != nil {
				t.Fatal(err)
			}
			testWrite(t, filepath.Join(wt, "ignored", "local.env"), "valuable\n")
		}},
		{"locked", "Locked", func(t *testing.T, repo, wt string) { testGit(t, repo, "worktree", "lock", "--reason", "keep this", wt) }},
		{"detached", "Detached", func(t *testing.T, repo, wt string) { testGit(t, wt, "checkout", "--detach") }},
		{"assume unchanged", "assume-unchanged", func(t *testing.T, repo, wt string) {
			testGit(t, wt, "update-index", "--assume-unchanged", "tracked.txt")
			testWrite(t, filepath.Join(wt, "tracked.txt"), "hidden modification\n")
		}},
		{"skip worktree", "Sparse", func(t *testing.T, repo, wt string) { testGit(t, wt, "update-index", "--skip-worktree", "tracked.txt") }},
		{"nested repository", "nested", func(t *testing.T, repo, wt string) { testRepo(t, filepath.Join(wt, "nested")) }},
		{"merge in progress", "operation in progress", func(t *testing.T, repo, wt string) {
			p := testGit(t, wt, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")
			testWrite(t, p, testGit(t, wt, "rev-parse", "HEAD")+"\n")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			tc.change(t, repo, wt)
			w := testTree(t, testScan(t, root), wt)
			assertProtected(t, w, tc.reason)
		})
	}
}

func TestScanMergedVersusUnmerged(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	merged := testLinked(t, repo, filepath.Join(root, "merged"), "merged-topic")
	unmerged := testLinked(t, repo, filepath.Join(root, "unmerged"), "active-topic")
	testWrite(t, filepath.Join(unmerged, "tracked.txt"), "new work\n")
	testGit(t, unmerged, "commit", "-am", "Active work")
	report := testScan(t, root)
	if !testTree(t, report, merged).Recommended {
		t.Fatal("merged clean tree was not recommended")
	}
	w := testTree(t, report, unmerged)
	if w.Merged || w.Recommended || !w.CanRemove || w.Published {
		t.Fatalf("unmerged tree classification: %+v", w)
	}
	testGit(t, repo, "merge", "--ff-only", "active-topic")
	if !testTree(t, testScan(t, root), unmerged).Recommended {
		t.Fatal("newly merged tree was not recommended")
	}
}

func TestScanPublishedUsesRemoteAncestry(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	initial := testGit(t, wt, "rev-parse", "HEAD")
	testWrite(t, filepath.Join(repo, "tracked.txt"), "remote advanced\n")
	testGit(t, repo, "commit", "-am", "Later remote commit")
	// Synthetic cached refs exercise ancestry without a network connection.
	testGit(t, repo, "update-ref", "refs/remotes/origin/main", "HEAD")
	testGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	w := testTree(t, testScan(t, root), wt)
	if w.Head != initial || !w.Published || !w.Merged || !w.Recommended || len(w.PublishedRefs) != 1 || w.PublishedRefs[0] != "origin/main" {
		t.Fatalf("ancestor publication: %+v", w)
	}
	testWrite(t, filepath.Join(wt, "topic.txt"), "unpushed\n")
	testGit(t, wt, "add", "topic.txt")
	testGit(t, wt, "commit", "-m", "Unpushed commit")
	w = testTree(t, testScan(t, root), wt)
	if w.Published || w.Merged || w.Recommended {
		t.Fatalf("new local commit must not count as published: %+v", w)
	}
}

func TestScanProtectsNonstandardDefaultBranch(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "trunk")
	testGit(t, repo, "update-ref", "refs/remotes/origin/trunk", "HEAD")
	testGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
	w := testTree(t, testScan(t, root), wt)
	assertProtected(t, w, "Default branch")
	if w.DefaultRef != "refs/remotes/origin/trunk" {
		t.Fatalf("wrong default ref: %s", w.DefaultRef)
	}
}

func TestScanUpstreamDivergence(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "local.txt"), "local change\n")
	testGit(t, wt, "add", "local.txt")
	testGit(t, wt, "commit", "-m", "Local work")
	testWrite(t, filepath.Join(repo, "remote.txt"), "remote change\n")
	testGit(t, repo, "add", "remote.txt")
	testGit(t, repo, "commit", "-m", "Remote work")
	testGit(t, repo, "remote", "add", "origin", "https://example.invalid/project.git")
	testGit(t, repo, "update-ref", "refs/remotes/origin/main", "HEAD")
	testGit(t, wt, "branch", "--set-upstream-to=origin/main")
	w := testTree(t, testScan(t, root), wt)
	if w.Upstream != "origin/main" || w.Ahead != 1 || w.Behind != 1 || w.Merged || w.Published || w.Recommended {
		t.Fatalf("incorrect divergence metadata: %+v", w)
	}
}

func TestScanCancellationAndInvalidRoot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, Options{Root: t.TempDir()}); err == nil {
		t.Fatal("canceled scan succeeded")
	}
	file := filepath.Join(t.TempDir(), "file")
	testWrite(t, file, "not a directory")
	if _, err := Scan(context.Background(), Options{Root: file}); err == nil {
		t.Fatal("file accepted as scan directory")
	}
	if _, err := Scan(context.Background(), Options{Root: filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("missing directory accepted")
	}
}

func TestScanResolvesSymlinkRoot(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	alias := filepath.Join(t.TempDir(), "workspace-alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	report := testScan(t, alias)
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if report.Root != canonical {
		t.Fatalf("root is not canonical: %q; want %q", report.Root, canonical)
	}
	w := testTree(t, report, wt)
	if w.OutsideRoot || !w.Recommended {
		t.Fatalf("symlink root incorrectly protects in-scope tree: %+v", w)
	}
}

// A fetch updates branches, not which one the remote calls its default. When a
// project renames that branch, the old name must stop deciding what is merged.
func TestFetchRefreshesTheRemoteDefaultBranch(t *testing.T) {
	root := t.TempDir()
	seed := testRepo(t, filepath.Join(t.TempDir(), "seed"))
	testGit(t, seed, "branch", "trunk")
	remote := filepath.Join(t.TempDir(), "remote.git")
	testGit(t, seed, "clone", "--bare", seed, remote)
	repo := filepath.Join(root, "repo")
	testGit(t, root, "clone", remote, repo)
	identity := []string{"-c", "user.name=Arbor Test", "-c", "user.email=arbor@example.invalid"}
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "topic\n")
	testGit(t, wt, append(identity, "commit", "-am", "Topic work")...)
	testGit(t, repo, append(identity, "merge", "--no-ff", "-m", "Merge topic", "topic")...)
	testGit(t, repo, "push", "origin", "main")
	if w := testTree(t, testScan(t, root), wt); w.DefaultRef != "refs/remotes/origin/main" || !w.Recommended {
		t.Fatalf("fixture must begin merged into the remote default branch: %+v", w)
	}
	// The project makes trunk its default. Trunk never received the topic.
	testGit(t, remote, "symbolic-ref", "HEAD", "refs/heads/trunk")
	report, err := Scan(context.Background(), Options{Root: root, Fetch: true})
	if err != nil || !report.Fetched || len(report.Warnings) != 0 {
		t.Fatalf("fetch: %v, fetched=%v, warnings=%v", err, report.Fetched, report.Warnings)
	}
	if w := testTree(t, report, wt); w.DefaultRef != "refs/remotes/origin/trunk" || w.Merged || w.Recommended {
		t.Fatalf("a renamed default branch left the old one deciding merges: %+v", w)
	}
}

// A clone that tracks one branch cannot follow its project to a new default
// branch. What was merged into the old one is then no evidence, and the scan
// says why nothing is recommended rather than only going quiet.
func TestFetchRecommendsNothingWhenTheDefaultBranchIsNotTracked(t *testing.T) {
	root := canonicalFixtureDir(t) // warnings name the canonical path
	seed := testRepo(t, filepath.Join(t.TempDir(), "seed"))
	testGit(t, seed, "branch", "trunk")
	remote := filepath.Join(t.TempDir(), "remote.git")
	testGit(t, seed, "clone", "--bare", seed, remote)
	repo := filepath.Join(root, "repo")
	testGit(t, root, "clone", "--single-branch", "--branch", "main", remote, repo)
	identity := []string{"-c", "user.name=Arbor Test", "-c", "user.email=arbor@example.invalid"}
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "topic\n")
	testGit(t, wt, append(identity, "commit", "-am", "Topic work")...)
	testGit(t, repo, append(identity, "merge", "--no-ff", "-m", "Merge topic", "topic")...)
	testGit(t, repo, "push", "origin", "main")
	if w := testTree(t, testScan(t, root), wt); w.DefaultRef != "refs/remotes/origin/main" || !w.Recommended {
		t.Fatalf("fixture must begin merged into the remote default branch: %+v", w)
	}
	testGit(t, remote, "symbolic-ref", "HEAD", "refs/heads/trunk")
	tracked := testGit(t, repo, "for-each-ref", "refs/remotes")
	report, err := Scan(context.Background(), Options{Root: root, Fetch: true})
	if err != nil || !report.Fetched {
		t.Fatalf("fetch: %v, fetched=%v", err, report.Fetched)
	}
	if w := testTree(t, report, wt); w.DefaultRef != "" || w.Merged || w.Recommended {
		t.Fatalf("a default branch that is not tracked left the old one deciding merges: %+v", w)
	}
	want := "Nothing is recommended in " + repo + ": the default branch of origin is trunk, which is not fetched here."
	if len(report.Warnings) != 1 || report.Warnings[0] != want {
		t.Fatalf("warnings %q, want %q", report.Warnings, want)
	}
	// No ref is invented for a branch that was never fetched.
	if after := testGit(t, repo, "for-each-ref", "refs/remotes"); after != tracked {
		t.Fatalf("remote-tracking refs changed:\n%s\nwas:\n%s", after, tracked)
	}

	if learned := testGit(t, repo, "config", "--local", "--get", "arbor.origin.head"); learned != "trunk" {
		t.Fatalf("the default branch the remote named was not recorded: %q", learned)
	}
	// What the fetch learned outlasts it. A later scan without a fetch, and
	// the fresh inspection every removal makes, must not go back to the
	// branch now known to be the wrong one.
	report, err = Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	w := testTree(t, report, wt)
	if w.DefaultRef != "" || w.Recommended || len(report.Warnings) != 1 || report.Warnings[0] != want {
		t.Fatalf("a scan without a fetch forgot the default branch: %+v %q", w, report.Warnings)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
		t.Fatal("cleanup removed a worktree whose default branch is not fetched here")
	}
	if _, err := os.Stat(wt); err != nil {
		t.Fatal("the worktree was removed")
	}
	// Once the clone fetches that branch, it decides. It never got the topic.
	testGit(t, repo, "remote", "set-branches", "--add", "origin", "trunk")
	testGit(t, repo, "fetch", "origin")
	if w := testTree(t, testScan(t, root), wt); w.DefaultRef != "refs/remotes/origin/trunk" || w.Merged || w.Recommended {
		t.Fatalf("the fetched default branch should decide: %+v", w)
	}
	// And when the project goes back to main, the next fetch says so.
	testGit(t, remote, "symbolic-ref", "HEAD", "refs/heads/main")
	report, err = Scan(context.Background(), Options{Root: root, Fetch: true})
	if err != nil || len(report.Warnings) != 0 {
		t.Fatalf("fetch: %v, warnings=%v", err, report.Warnings)
	}
	if w := testTree(t, report, wt); w.DefaultRef != "refs/remotes/origin/main" || !w.Recommended {
		t.Fatalf("the restored default branch should decide again: %+v", w)
	}
	if config, err := os.ReadFile(filepath.Join(repo, ".git", "config")); err != nil || strings.Contains(string(config), "[arbor ") {
		t.Fatalf("a record that no longer applies was left behind: %v\n%s", err, config)
	}
}

// One remote decides what is merged: a fork's upstream when there is one,
// otherwise the origin. When it cannot say, nothing else answers for it.
func TestOnlyTheDecidingRemoteSaysWhatIsMerged(t *testing.T) {
	fixture := func(t *testing.T) (root, repo, wt string) {
		root = canonicalFixtureDir(t) // warnings name the canonical path
		repo = testRepo(t, filepath.Join(root, "repo"))
		wt = testLinked(t, repo, filepath.Join(root, "linked"), "topic")
		testWrite(t, filepath.Join(wt, "tracked.txt"), "topic\n")
		testGit(t, wt, "commit", "-am", "Topic work")
		testGit(t, repo, "merge", "--ff-only", "topic")
		return root, repo, wt
	}
	scan := func(t *testing.T, root, wt string) (Worktree, []string) {
		t.Helper()
		report, err := Scan(context.Background(), Options{Root: root})
		if err != nil {
			t.Fatal(err)
		}
		return testTree(t, report, wt), report.Warnings
	}
	t.Run("an upstream that was never fetched does not yield to a cloned fork", func(t *testing.T) {
		root, repo, wt := fixture(t)
		testGit(t, repo, "remote", "add", "origin", "https://example.invalid/me/project.git")
		testGit(t, repo, "update-ref", "refs/remotes/origin/main", "refs/heads/main")
		testGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
		if w, warnings := scan(t, root, wt); w.DefaultRef != "refs/remotes/origin/main" || !w.Recommended || len(warnings) != 0 {
			t.Fatalf("fixture must begin merged into origin: %+v %v", w, warnings)
		}
		testGit(t, repo, "remote", "add", "upstream", "https://example.invalid/owner/project.git")
		w, warnings := scan(t, root, wt)
		if w.DefaultRef != "" || w.Merged || w.Recommended {
			t.Fatalf("the fork's default branch answered for the upstream: %+v", w)
		}
		want := "Nothing is recommended in " + repo + ": upstream has not been fetched, so what has been merged into it is not known. Fetch it, or scan with fetching on."
		if len(warnings) != 1 || warnings[0] != want {
			t.Fatalf("warnings %q, want %q", warnings, want)
		}
		// Once the upstream is known, it decides, and it has the work.
		testGit(t, repo, "update-ref", "refs/remotes/upstream/main", "refs/heads/main")
		if w, warnings := scan(t, root, wt); w.DefaultRef != "refs/remotes/upstream/main" || !w.Recommended || len(warnings) != 0 {
			t.Fatalf("a fetched upstream should decide: %+v %v", w, warnings)
		}
	})
	t.Run("a tracked remote with no known default branch does not yield to a local branch", func(t *testing.T) {
		root, repo, wt := fixture(t)
		testGit(t, repo, "remote", "add", "origin", "https://example.invalid/me/project.git")
		testGit(t, repo, "update-ref", "refs/remotes/origin/feature", "refs/heads/main")
		w, warnings := scan(t, root, wt)
		if w.DefaultRef != "" || w.Merged || w.Recommended {
			t.Fatalf("a local branch answered for origin: %+v", w)
		}
		if len(warnings) != 1 || !strings.Contains(warnings[0], "the default branch of origin is not known") {
			t.Fatalf("warnings: %q", warnings)
		}
	})
	t.Run("a default branch that is gone from here is not replaced by a guess", func(t *testing.T) {
		root, repo, wt := fixture(t)
		testGit(t, repo, "remote", "add", "origin", "https://example.invalid/me/project.git")
		testGit(t, repo, "update-ref", "refs/remotes/origin/main", "refs/heads/main")
		// The project's default was develop; that branch has been pruned.
		testGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
		w, warnings := scan(t, root, wt)
		if w.DefaultRef != "" || w.Merged || w.Recommended {
			t.Fatalf("a conventional name answered for a default branch that changed: %+v", w)
		}
		if len(warnings) != 1 || !strings.Contains(warnings[0], "the branch recorded as the default of origin, develop, is no longer here") {
			t.Fatalf("warnings: %q", warnings)
		}
	})
	t.Run("a remote nothing was ever exchanged with leaves the repository's own branch", func(t *testing.T) {
		root, repo, wt := fixture(t)
		testGit(t, repo, "remote", "add", "origin", "https://example.invalid/me/project.git")
		if w, warnings := scan(t, root, wt); w.DefaultRef != "refs/heads/main" || !w.Recommended || len(warnings) != 0 {
			t.Fatalf("an unused origin hid the local default branch: %+v %v", w, warnings)
		}
	})
}

// A bare clone keeps origin's branches as its own and tracks none of them as
// origin's, so its own default branch decides, fetched or not.
func TestBareCloneUsesItsOwnDefaultBranch(t *testing.T) {
	isolatedBareGlobalConfig(t, "all")
	root := t.TempDir()
	seed := testRepo(t, filepath.Join(t.TempDir(), "seed"))
	bare := filepath.Join(root, "project.git")
	testGit(t, seed, "clone", "--bare", seed, bare)
	wt := testLinked(t, bare, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "topic\n")
	testGit(t, wt, "-c", "user.name=Arbor Test", "-c", "user.email=arbor@example.invalid", "commit", "-am", "Topic work")
	testGit(t, bare, "update-ref", "refs/heads/main", "refs/heads/topic")
	for _, fetch := range []bool{false, true} {
		report, err := Scan(context.Background(), Options{Root: root, Fetch: fetch})
		if err != nil || report.Fetched != fetch || len(report.Warnings) != 0 {
			t.Fatalf("fetch=%v: %v, fetched=%v, warnings=%v", fetch, err, report.Fetched, report.Warnings)
		}
		if w := testTree(t, report, wt); w.DefaultRef != "refs/heads/main" || !w.Recommended {
			t.Fatalf("fetch=%v: a bare clone lost its default branch: %+v", fetch, w)
		}
	}
}

// A repository with no remote and a default branch that is not main or master
// still has finished work to recognize. The name Git is configured to give
// new repositories is a preference about the future, not a record of which
// branch this repository integrates into, so it vouches for nothing.
func TestLocalDefaultBranchNames(t *testing.T) {
	for _, tc := range []struct {
		name, initial, configured, want string
	}{
		{"trunk", "trunk", "", "refs/heads/trunk"},
		{"the name Git is configured to give new repositories", "stable", "stable", ""},
		{"an unconventional name nothing vouches for", "stable", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			repo := filepath.Join(root, "repo")
			if err := os.MkdirAll(repo, 0700); err != nil {
				t.Fatal(err)
			}
			testGit(t, repo, "init", "--initial-branch="+tc.initial)
			testGit(t, repo, "config", "user.name", "Arbor Test")
			testGit(t, repo, "config", "user.email", "arbor@example.invalid")
			if tc.configured != "" {
				testGit(t, repo, "config", "init.defaultBranch", tc.configured)
			}
			testWrite(t, filepath.Join(repo, "tracked.txt"), "initial\n")
			testGit(t, repo, "add", ".")
			testGit(t, repo, "commit", "-m", "Initial tree")
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			testWrite(t, filepath.Join(wt, "tracked.txt"), "topic\n")
			testGit(t, wt, "commit", "-am", "Topic work")
			testGit(t, repo, "merge", "--ff-only", "topic")
			w := testTree(t, testScan(t, root), wt)
			if w.DefaultRef != tc.want || w.Recommended != (tc.want != "") {
				t.Fatalf("default ref %q recommended %v, want %q: %+v", w.DefaultRef, w.Recommended, tc.want, w)
			}
		})
	}
}

// A warning that only names a repository leaves its owner guessing. Git said
// why it refused; that one line belongs in the warning.
func TestUninspectableRepositoryWarningSaysWhy(t *testing.T) {
	root := canonicalFixtureDir(t) // warnings name the canonical path
	broken := filepath.Join(root, "broken")
	if err := os.Mkdir(broken, 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(broken, ".git"), "gitdir: /nonexistent/arbor-fixture\n")
	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil || len(report.Warnings) != 1 {
		t.Fatalf("scan: %v %v", err, report.Warnings)
	}
	warning := report.Warnings[0]
	if !strings.HasPrefix(warning, "Could not inspect repository: "+broken+" (") || !strings.Contains(warning, "not a git repository") || strings.Contains(warning, "\n") || strings.Contains(warning, "(null)") {
		t.Fatalf("warning does not carry Git's reason on one line: %q", warning)
	}
	if gitReason(nil) != "" || gitReason(errors.New("git: fatal: detected dubious ownership in repository at '/srv/x'\nTo add an exception, run a command")) != " (detected dubious ownership in repository at '/srv/x')" {
		t.Fatal("a Git failure should reduce to its first line without prefixes")
	}
	if got := gitReason(errors.New("git: warning: redirecting to https://example.invalid/\nfatal: unable to access the remote\nerror: could not fetch origin")); got != " (unable to access the remote)" {
		t.Fatalf("the line Git gave up on should be the reason: %q", got)
	}
	if got := gitReason(errors.New("fatal: not a git repository: (null)")); got != " (not a git repository)" {
		t.Fatalf("Git's placeholder for no directory leaked: %q", got)
	}
}
