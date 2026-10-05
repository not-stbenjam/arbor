package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func restrictiveBareGlobalConfig(t *testing.T) {
	t.Helper()
	isolatedBareGlobalConfig(t, "explicit")
}

func isolatedBareGlobalConfig(t *testing.T, policy string) {
	t.Helper()
	gitBinary, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	fixture := canonicalFixtureDir(t)
	config := filepath.Join(fixture, "global.gitconfig")
	testWrite(t, config, "[safe]\n\tbareRepository = "+policy+"\n")
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }
	// Arbor strips inherited GIT_* selectors. This fixture shim supplies an
	// isolated global config at Git's own boundary without changing HOME or
	// touching the user's real configuration.
	shim := filepath.Join(fixture, "git")
	testWrite(t, shim, "#!/bin/sh\nGIT_CONFIG_GLOBAL="+quote(config)+" GIT_CONFIG_NOSYSTEM=1 exec "+quote(gitBinary)+" \"$@\"\n")
	if err := os.Chmod(shim, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fixture+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestRestrictiveGlobalConfigStillProtectsNestedBareRepositories(t *testing.T) {
	for _, kind := range []string{"untracked", "ignored"} {
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
			testGit(t, parent, "clone", "--bare", repo, nested)
			heldCommit := testGit(t, nested, "rev-parse", "HEAD")
			restrictiveBareGlobalConfig(t)
			// Confirm the fixture really forbids implicit bare discovery.
			if _, err := git(context.Background(), nested, "rev-parse", "--is-bare-repository"); err == nil {
				t.Fatal("global explicit-only bare configuration was not applied")
			}
			targeted, err := Scan(context.Background(), Options{Root: checkout, TargetOnly: true, LinkedOnly: true})
			if err != nil || len(targeted.Worktrees) != 1 {
				t.Fatalf("target scan: %+v %v", targeted, err)
			}
			w := targeted.Worktrees[0]
			if w.CanRemove || w.Recommended || !slices.Contains(w.Losses, "nested") || !strings.Contains(strings.Join(w.Blockers, " "), "Nested repository") {
				t.Fatalf("explicit-only Git config hid nested bare repository: %+v", w)
			}
			full := testScan(t, root)
			if !testTree(t, full, nested).Bare {
				t.Fatal("full scan failed to discover the explicit bare repository")
			}
			if parent := testTree(t, full, checkout); parent.CanRemove || parent.Recommended || !slices.Contains(parent.Losses, "nested") {
				t.Fatalf("full scan did not name the nested repository as a loss: %+v", parent)
			}
			// It appeared after this snapshot was taken, so no agreement made
			// then can have covered it.
			if _, err := RemoveWorktree(context.Background(), before, RemovalOptions{ExpectedHead: before.Head, DiscardLocal: true}); err == nil || !strings.Contains(err.Error(), "separate Git repository") {
				t.Fatalf("fresh validation failed to protect newly added nested bare repository: %v", err)
			}
			if got := testGit(t, repo, "--git-dir="+nested, "rev-parse", "HEAD"); got != heldCommit {
				t.Fatal("nested bare commit lost")
			}
		})
	}
}

func TestRestrictiveGlobalConfigSupportsBareBackedCheckoutCleanup(t *testing.T) {
	for _, kind := range []string{"present", "missing", "empty", "detached"} {
		t.Run(kind, func(t *testing.T) {
			root := canonicalFixtureDir(t)
			source := testRepo(t, filepath.Join(root, "source"))
			bare := filepath.Join(root, "backing.git")
			testGit(t, root, "clone", "--bare", source, bare)
			checkout := testLinked(t, bare, filepath.Join(root, "session"), "session")
			if kind == "detached" {
				testGit(t, checkout, "config", "user.name", "Arbor Test")
				testGit(t, checkout, "config", "user.email", "arbor@example.invalid")
				testGit(t, checkout, "checkout", "--detach")
				testWrite(t, filepath.Join(checkout, "tracked.txt"), "unique detached work\n")
				testGit(t, checkout, "commit", "-am", "Retain detached work")
			}
			if kind == "missing" || kind == "empty" {
				moveFixtureCheckout(t, checkout)
				if kind == "empty" {
					if err := os.Mkdir(checkout, 0700); err != nil {
						t.Fatal(err)
					}
				}
			}
			restrictiveBareGlobalConfig(t)
			// Read-only discovery remains available under the restrictive policy.
			full, err := Scan(context.Background(), Options{Root: root})
			if err != nil || len(full.Warnings) != 0 {
				t.Fatalf("bare discovery under restrictive global config: %+v, %v", full, err)
			}
			if !testTree(t, full, bare).Bare {
				t.Fatal("bare backing repository omitted")
			}
			report, err := Scan(context.Background(), Options{Root: checkout, Repository: bare, TargetOnly: true, LinkedOnly: true})
			if err != nil || len(report.Worktrees) != 1 {
				t.Fatalf("target with explicit repository hint: %+v, %v", report, err)
			}
			w := report.Worktrees[0]
			if !w.CanDiscard {
				t.Fatalf("verified bare-backed checkout blocked: %+v", w)
			}
			result, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true})
			if err != nil || !result.Removed {
				t.Fatalf("bare-backed cleanup: %+v, %v", result, err)
			}
			if _, err := os.Stat(checkout); !os.IsNotExist(err) {
				t.Fatalf("checkout still exists: %v", err)
			}
			branch := w.Branch
			if kind == "detached" {
				branch = result.RetainedBranch
				if branch == "" {
					t.Fatal("unique detached commit was not retained")
				}
			}
			if got := testGit(t, root, "--git-dir="+bare, "rev-parse", "refs/heads/"+branch); got != w.Head {
				t.Fatal("retained commit differs")
			}
		})
	}
}

func TestFetchHonorsOrdinaryRepositorySafetyPolicy(t *testing.T) {
	for _, kind := range []string{"bare-allowed", "checkout-allowed", "bare-explicit-only"} {
		t.Run(kind, func(t *testing.T) {
			root := canonicalFixtureDir(t)
			source := testRepo(t, filepath.Join(root, "source"))
			target := filepath.Join(root, "target")
			args := []string{"clone"}
			bare := kind != "checkout-allowed"
			if bare {
				args = append(args, "--bare")
			}
			testGit(t, root, append(args, source, target)...)
			common := target
			if !bare {
				common = filepath.Join(target, ".git")
			}
			fetchHead := filepath.Join(common, "FETCH_HEAD")
			if _, err := os.Stat(fetchHead); !os.IsNotExist(err) {
				t.Fatalf("fixture unexpectedly fetched already: %v", err)
			}
			restricted := kind == "bare-explicit-only"
			if restricted {
				restrictiveBareGlobalConfig(t)
			} else {
				isolatedBareGlobalConfig(t, "all")
			}
			// Both sides are disposable local fixtures; no network is involved.
			report, err := Scan(context.Background(), Options{Root: target, Fetch: true})
			if err != nil {
				t.Fatal(err)
			}
			w := testTree(t, report, target)
			if w.Bare != bare {
				t.Fatalf("read-only repository discovery changed: %+v", w)
			}
			if restricted {
				if report.Fetched || !strings.Contains(strings.Join(report.Warnings, " "), "safe.bareRepository") {
					t.Fatalf("fetch did not report the Git safety refusal: %+v", report)
				}
				if _, err := os.Stat(fetchHead); !os.IsNotExist(err) {
					t.Fatalf("restricted repository was fetched: %v", err)
				}
			} else {
				if !report.Fetched || len(report.Warnings) != 0 {
					t.Fatalf("ordinary allowed fetch was blocked: %+v", report)
				}
				if info, err := os.Stat(fetchHead); err != nil || info.Size() == 0 {
					t.Fatalf("ordinary fetch did not write FETCH_HEAD: %v", err)
				}
			}
		})
	}
}

// A repository inside a worktree is never offered for cleanup and never goes
// on a general agreement to discard local files, least of all one given
// before it was there. It goes only when that loss was shown and accepted.
func TestNestedBareRepositoryIsDeletedOnlyWhenNamed(t *testing.T) {
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
			if w.CanRemove || w.Recommended || !w.CanDiscard || !slices.Contains(w.Losses, "nested") || !strings.Contains(strings.Join(w.Blockers, " "), "Nested repository") {
				t.Fatalf("nested bare data was not named as a loss: %+v", w)
			}
			for _, options := range []RemovalOptions{
				{ExpectedHead: before.Head, DiscardLocal: true},
				{ExpectedHead: before.Head, RecommendedOnly: true},
				{ExpectedHead: before.Head},
				// Naming some other loss is not naming this one.
				{ExpectedHead: before.Head, DiscardLocal: true, Acknowledged: []string{"submodules", "operation"}},
			} {
				if _, err := RemoveWorktree(context.Background(), before, options); err == nil || (options.DiscardLocal && !strings.Contains(err.Error(), "separate Git repository")) {
					t.Fatalf("a nested repository went without being named (%+v): %v", options, err)
				}
			}
			if got := testGit(t, nested, "rev-parse", "HEAD"); got != heldCommit {
				t.Fatal("nested committed work lost")
			}
			if _, err := os.Stat(filepath.Join(checkout, "tracked.txt")); err != nil {
				t.Fatal(err)
			}
			if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: []string{"nested"}}); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(checkout); !os.IsNotExist(err) {
				t.Fatalf("the worktree was not removed once its loss was named: %v", err)
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
	restrictiveBareGlobalConfig(t)
	w := testTree(t, testScan(t, root), checkout)
	if !w.CanDiscard || strings.Contains(strings.Join(w.Blockers, " "), "Nested repository") {
		t.Fatalf("lookalikes classified as repository: %+v", w)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true}); err != nil {
		t.Fatal(err)
	}
}

func TestNestedSeparateGitDirectoryIsProtected(t *testing.T) {
	for _, restrictive := range []bool{false, true} {
		t.Run(map[bool]string{false: "default", true: "explicit-only"}[restrictive], func(t *testing.T) {
			root := canonicalFixtureDir(t)
			repo := testRepo(t, filepath.Join(root, "repo"))
			checkout := testLinked(t, repo, filepath.Join(root, "session"), "session")
			store := filepath.Join(checkout, "ignored", "store")
			if err := os.MkdirAll(filepath.Dir(store), 0700); err != nil {
				t.Fatal(err)
			}
			independent := testRepo(t, filepath.Join(root, "independent"))
			testWrite(t, filepath.Join(independent, "tracked.txt"), "independent committed data\n")
			testGit(t, independent, "commit", "-am", "Independent work")
			held := testGit(t, independent, "rev-parse", "HEAD")
			testGit(t, independent, "init", "--separate-git-dir="+store)
			if restrictive {
				restrictiveBareGlobalConfig(t)
			}
			full := testScan(t, root)
			for _, options := range []Options{{Root: checkout, TargetOnly: true, LinkedOnly: true}, {Root: root}} {
				report, err := Scan(context.Background(), options)
				if err != nil {
					t.Fatal(err)
				}
				w := testTree(t, report, checkout)
				if w.CanRemove || w.Recommended || !slices.Contains(w.Losses, "nested") || !strings.Contains(strings.Join(w.Blockers, " "), "Nested repository") {
					t.Fatalf("separate metadata was not named as a loss: %+v", w)
				}
				if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true}); err == nil {
					t.Fatal("separate metadata went on a general agreement to discard local files")
				}
			}
			for _, w := range full.Worktrees {
				if w.Path == store && w.Bare {
					t.Fatal("non-bare metadata misclassified as a bare repository")
				}
			}
			if got := testGit(t, independent, "rev-parse", "HEAD"); got != held {
				t.Fatal("inspection changed independent committed data")
			}
		})
	}
}

func TestFailedCredibleRepositoryProbeBlocksCleanup(t *testing.T) {
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	checkout := testLinked(t, repo, filepath.Join(root, "session"), "session")
	nested := filepath.Join(checkout, "ignored", "store")
	if err := os.MkdirAll(filepath.Dir(nested), 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, root, "clone", "--bare", repo, nested)
	testWrite(t, filepath.Join(nested, "config"), "[invalid configuration\n")
	restrictiveBareGlobalConfig(t)
	report, err := Scan(context.Background(), Options{Root: checkout, TargetOnly: true, LinkedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	w := testTree(t, report, checkout)
	if w.CanRemove || w.CanDiscard || w.Recommended || !strings.Contains(strings.Join(w.Problems, " "), "cannot verify nested Git metadata") {
		t.Fatalf("uncertain Git metadata was treated as ordinary disposable data: %+v", w)
	}
}
