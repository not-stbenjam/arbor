package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExcludesDefaultsAndExplicitOverride(t *testing.T) {
	root := t.TempDir()
	testRepo(t, filepath.Join(root, "repo"))
	testRepo(t, filepath.Join(root, "node_modules", "nested"))
	testRepo(t, filepath.Join(root, "deep", "tmp", "nested"))
	for _, tc := range []struct {
		name  string
		rules []string
		want  int
	}{
		{"defaults", nil, 1},
		{"disabled", []string{}, 3},
		{"relative", []string{"deep/tmp"}, 2},
		{"absolute", []string{filepath.Join(root, "node_modules")}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report, err := Scan(context.Background(), Options{Root: root, Excludes: tc.rules})
			if err != nil || len(report.Worktrees) != tc.want {
				t.Fatalf("scan: %d worktrees, %v", len(report.Worktrees), err)
			}
		})
	}
	// Deliberately selecting an excluded directory still scans that root.
	selected := filepath.Join(root, "node_modules")
	report, err := Scan(context.Background(), Options{Root: selected, Excludes: []string{selected, "node_modules"}})
	if err != nil || len(report.Worktrees) != 1 {
		t.Fatalf("explicit root was excluded: %+v %v", report, err)
	}
}

func TestExcludesOmitRegisteredWorktreesAndProgress(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	hidden := testLinked(t, repo, filepath.Join(root, "node_modules", "hidden"), "hidden")
	testLinked(t, repo, filepath.Join(root, "visible"), "visible")
	report, err := Scan(context.Background(), Options{Root: root, Progress: func(event Progress) {
		if event.Worktree != nil && event.Worktree.Path == hidden {
			t.Errorf("excluded registered worktree leaked into progress: %+v", event)
		}
	}})
	if err != nil || len(report.Worktrees) != 2 {
		t.Fatalf("scan: %+v %v", report, err)
	}
	for _, w := range report.Worktrees {
		if w.Path == hidden {
			t.Fatal("registered exclusion was inspected")
		}
	}
}

func TestExcludedDirectoriesStillBlockUnsafeRemoval(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "feature"), "feature")
	testWrite(t, filepath.Join(repo, ".git", "info", "exclude"), "node_modules/\n")
	if err := os.Mkdir(filepath.Join(wt, "node_modules"), 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(wt, "node_modules", "precious-data"), "retain this file")
	report := testScan(t, root)
	w := testTree(t, report, wt)
	if !w.Ignored || w.CanRemove || w.Recommended || w.SizeBytes < int64(len("retain this file")) {
		t.Fatalf("excluded files were hidden from safety/measurement: %+v", w)
	}
	if err := Remove(context.Background(), w, w.Head, false); err == nil {
		t.Fatal("removed ignored files inside excluded folder")
	}
}

func TestExcludeValidationAndHomePaths(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	excluded, err := compileExcludes(root, nil)
	if err != nil || !excluded(filepath.Join(root, "Library", "Caches", "repo")) || excluded(filepath.Join(root, "Library", "Projects")) {
		t.Fatalf("home-relative exclusions failed: %v", err)
	}
	for _, rules := range [][]string{{""}, {"a\x00b"}, {strings.Repeat("a", 4097)}, make([]string, 129), {"."}, {".."}} {
		if _, err := compileExcludes(root, rules); err == nil {
			t.Fatalf("invalid exclusions accepted: %q", rules)
		}
	}
}
