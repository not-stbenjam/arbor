package worktree

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestExplicitDiscardRemovesLinkedLocalFilesButKeepsBranch(t *testing.T) {
	for _, kind := range []string{"dirty", "ignored", "locked", "detached", "protected"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			switch kind {
			case "dirty":
				testWrite(t, filepath.Join(wt, "tracked.txt"), "discard this edit\n")
				testWrite(t, filepath.Join(wt, "untracked.txt"), "discard this file\n")
			case "ignored":
				if err := os.Mkdir(filepath.Join(wt, "ignored"), 0700); err != nil {
					t.Fatal(err)
				}
				testWrite(t, filepath.Join(wt, "ignored", "output"), "discard output\n")
			case "locked":
				testGit(t, repo, "worktree", "lock", "--reason", "user test", wt)
			case "detached":
				testGit(t, wt, "checkout", "--detach")
				testWrite(t, filepath.Join(wt, "tracked.txt"), "unique detached commit\n")
				testGit(t, wt, "commit", "-am", "Retain detached work")
			case "protected":
				testGit(t, wt, "checkout", "-b", "develop")
			}
			w := testTree(t, testScan(t, root), wt)
			if w.CanRemove || w.Recommended || !w.CanDiscard {
				t.Fatalf("wrong policy: %+v", w)
			}
			if err := Remove(context.Background(), w, w.Head, false); err == nil {
				t.Fatal("normal removal discarded local state")
			}
			if _, err := os.Stat(wt); err != nil {
				t.Fatal(err)
			}
			if err := RemoveWithOptions(context.Background(), w, w.Head, true, true); err == nil {
				t.Fatal("automatic cleanup allowed discard")
			}
			result, err := RemoveWithResult(context.Background(), w, w.Head, false, true)
			if err != nil {
				t.Fatal(err)
			}
			if !result.Removed || result.Path != w.Path || result.Error != "" || (kind == "detached" && result.RetainedBranch != RecoveryBranch(w)) || (kind != "detached" && result.RetainedBranch != "") {
				t.Fatalf("incorrect removal result: %+v", result)
			}
			if _, err := os.Stat(wt); !os.IsNotExist(err) {
				t.Fatalf("worktree still exists: %v", err)
			}
			branch := w.Branch
			if kind == "detached" {
				branch = RecoveryBranch(w)
			}
			if got := testGit(t, repo, "rev-parse", "refs/heads/"+branch); got != w.Head {
				t.Fatalf("commit not preserved: %s", got)
			}
			if _, err := os.Stat(filepath.Join(repo, "tracked.txt")); err != nil {
				t.Fatalf("primary checkout changed: %v", err)
			}
		})
	}
}

func TestDetachedRemovalDoesNotCreateRedundantRecoveryBranch(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testGit(t, wt, "checkout", "--detach")
	w := testTree(t, testScan(t, root), wt)
	result, err := RemoveWithResult(context.Background(), w, w.Head, false, true)
	if err != nil || !result.Removed || result.RetainedBranch != "" {
		t.Fatalf("unexpected result: %+v, %v", result, err)
	}
	if refs := testGit(t, repo, "for-each-ref", "--format=%(refname)", "refs/heads/arbor/retained/"); refs != "" {
		t.Fatalf("redundant recovery branch: %s", refs)
	}
	if head := testGit(t, repo, "rev-parse", "main"); head != w.Head {
		t.Fatal("detached commit not retained")
	}
}

func TestExplicitDiscardStillChecksIdentityAndStructuralProblems(t *testing.T) {
	for _, kind := range []string{"primary", "outside", "nested", "changed-head", "changed-branch"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			if kind == "nested" {
				testRepo(t, filepath.Join(wt, "nested"))
			}
			w := testTree(t, testScan(t, root), wt)
			switch kind {
			case "primary":
				w = testTree(t, testScan(t, root), repo)
			case "outside":
				w.OutsideRoot = true
			case "changed-head":
				testWrite(t, filepath.Join(wt, "tracked.txt"), "new commit\n")
				testGit(t, wt, "commit", "-am", "Changed after confirmation")
			case "changed-branch":
				testGit(t, wt, "checkout", "-b", "other")
			}
			if err := RemoveWithOptions(context.Background(), w, w.Head, false, true); err == nil {
				t.Fatal("discard bypassed target validation")
			}
			if _, err := os.Stat(wt); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(repo); err != nil {
				t.Fatal(err)
			}
		})
	}
}
