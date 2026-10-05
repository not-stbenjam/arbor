package worktree

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLinkedOnlyOmitsPrimaryRepositoriesAndProvisionalRows(t *testing.T) {
	root := t.TempDir()
	testRepo(t, filepath.Join(root, "ordinary"))
	testRepo(t, filepath.Join(root, "ordinary", "nested"))
	report, err := Scan(context.Background(), Options{Root: root, LinkedOnly: true, Progress: func(event Progress) {
		if event.Worktree != nil || event.Stage == "inspect" && event.Total != 0 {
			t.Errorf("primary repository emitted or inspected: %+v", event)
		}
	}})
	if err != nil || len(report.Worktrees) != 0 {
		t.Fatalf("ordinary repositories became linked worktrees: %+v, %v", report, err)
	}
}

func TestLinkedOnlyPreservesRegisteredWorktreesAndGrouping(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := testRepo(t, filepath.Join(root, "ordinary"))
	linked := testLinked(t, repo, filepath.Join(root, "feature"), "feature")
	excluded := testLinked(t, repo, filepath.Join(root, "node_modules", "hidden"), "hidden")
	outside := testLinked(t, repo, filepath.Join(t.TempDir(), "outside"), "outside")
	outside, err = filepath.EvalSymlinks(outside)
	if err != nil {
		t.Fatal(err)
	}
	report, err := Scan(context.Background(), Options{Root: root, LinkedOnly: true, Progress: func(event Progress) {
		if event.Worktree != nil && (event.Worktree.Main || event.Worktree.Bare || event.Worktree.OutsideRoot || event.Worktree.Path == repo || event.Worktree.Path == excluded || event.Worktree.Path == outside || event.Worktree.CommonDir == "") {
			t.Errorf("unclassified or primary row emitted: %+v", event)
		}
	}})
	if err != nil || len(report.Worktrees) != 1 {
		t.Fatalf("linked scan: %+v, %v", report, err)
	}
	w := testTree(t, report, linked)
	if w.Repo != "ordinary" || w.CommonDir != filepath.Join(repo, ".git") || !w.CanRemove {
		t.Fatalf("linked grouping or safety metadata lost: %+v", w)
	}
}

func TestLinkedOnlyScopeOmitsRegisteredSiblingsOutsideSelectedFolder(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := testRepo(t, filepath.Join(root, "primary"))
	sessions := filepath.Join(root, "sessions")
	selected := testLinked(t, repo, filepath.Join(sessions, "current"), "current")
	testLinked(t, repo, filepath.Join(root, "elsewhere", "sibling"), "sibling")
	report, err := Scan(context.Background(), Options{Root: sessions, LinkedOnly: true, Progress: func(event Progress) {
		if event.Worktree != nil && event.Worktree.Path != selected {
			t.Errorf("scoped scan leaked registered sibling into progress: %+v", event.Worktree)
		}
		if event.Stage == "inspect" && event.Total != 1 {
			t.Errorf("scoped scan inspected out-of-scope siblings: %+v", event)
		}
	}})
	if err != nil || len(report.Worktrees) != 1 {
		t.Fatalf("scoped scan: %+v, %v", report, err)
	}
	w := testTree(t, report, selected)
	if w.OutsideRoot || w.CommonDir != filepath.Join(repo, ".git") || w.Repo != "primary" {
		t.Fatalf("scoped worktree lost parent grouping: %+v", w)
	}
}

func TestTargetOnlyInspectsExactRegisteredCheckout(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := testRepo(t, filepath.Join(root, "repo"))
	linked := testLinked(t, repo, filepath.Join(root, "feature"), "feature")
	testLinked(t, repo, filepath.Join(root, "sibling"), "sibling")
	report, err := Scan(context.Background(), Options{Root: linked, TargetOnly: true, Progress: func(event Progress) {
		if event.Worktree != nil && event.Worktree.Path != linked || event.Stage == "inspect" && event.Total != 1 {
			t.Errorf("target-only scan inspected sibling: %+v", event)
		}
	}})
	if err != nil || len(report.Worktrees) != 1 || !report.Worktrees[0].CanRemove {
		t.Fatalf("targeted linked inspection: %+v, %v", report, err)
	}
	// A real nested repository remains a blocker, despite no discovery walk.
	testRepo(t, filepath.Join(linked, "nested"))
	report, err = Scan(context.Background(), Options{Root: linked, TargetOnly: true})
	if err != nil || len(report.Worktrees) != 1 {
		t.Fatalf("nested target: %+v, %v", report, err)
	}
	assertProtected(t, report.Worktrees[0], "Nested repository")
	if _, err := RemoveWorktree(context.Background(), report.Worktrees[0], RemovalOptions{ExpectedHead: report.Worktrees[0].Head}); err == nil {
		t.Fatal("target-only scan weakened nested-repository deletion protection")
	}
}

func TestTargetOnlyRejectsSubdirectoryAndProtectsPrimary(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	subdirectory := filepath.Join(repo, "ordinary-folder")
	if err := os.Mkdir(subdirectory, 0700); err != nil {
		t.Fatal(err)
	}
	report, err := Scan(context.Background(), Options{Root: subdirectory, TargetOnly: true})
	if err != nil || len(report.Worktrees) != 0 {
		t.Fatalf("ordinary subdirectory became target: %+v, %v", report, err)
	}
	report, err = Scan(context.Background(), Options{Root: repo, TargetOnly: true})
	if err != nil || len(report.Worktrees) != 1 {
		t.Fatalf("targeted primary: %+v, %v", report, err)
	}
	assertProtected(t, report.Worktrees[0], "Primary")
	if _, err := RemoveWorktree(context.Background(), report.Worktrees[0], RemovalOptions{ExpectedHead: report.Worktrees[0].Head}); err == nil {
		t.Fatal("target-only scan allowed primary repository deletion")
	}
}
