package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Direct matcher tests follow Scan's canonical-path contract. On macOS,
// t.TempDir commonly returns /var/... while ResolveRoot yields /private/var/...
// Canonicalize the existing parent before appending synthetic test paths.
func exclusionTempRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

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
	for _, rules := range [][]string{nil, {"node_*"}} {
		report, err := Scan(context.Background(), Options{Root: root, Excludes: rules, SafeIgnored: []string{}})
		if err != nil {
			t.Fatal(err)
		}
		w := testTree(t, report, wt)
		if !w.Ignored || w.CanRemove || w.Recommended || w.SizeBytes < int64(len("retain this file")) {
			t.Fatalf("excluded files were hidden from safety/measurement: %+v", w)
		}
		if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, SafeIgnored: []string{}}); err == nil {
			t.Fatal("removed ignored files inside excluded folder")
		}
	}
}

func TestExcludeValidationAndHomePaths(t *testing.T) {
	root := exclusionTempRoot(t)
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

func TestDefaultExcludesCodexScratchButKeepsManagedWorktrees(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", root)
	repo := testRepo(t, filepath.Join(root, "repo"))
	managed := testLinked(t, repo, filepath.Join(root, ".codex", "worktrees", "feature"), "feature")
	scratchRoot := filepath.Join(root, ".codex", ".tmp")
	testLinked(t, repo, filepath.Join(scratchRoot, "linked"), "scratch")
	bare := filepath.Join(scratchRoot, "git-example")
	for _, name := range []string{"objects", "refs"} {
		if err := os.MkdirAll(filepath.Join(bare, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	testWrite(t, filepath.Join(bare, "HEAD"), "ref: refs/heads/main\n")
	report, err := Scan(context.Background(), Options{Root: root, Progress: func(event Progress) {
		if event.Worktree != nil && within(scratchRoot, event.Worktree.Path) {
			t.Errorf("Codex scratch repository leaked into progress: %s", event.Worktree.Path)
		}
	}})
	if err != nil || len(report.Worktrees) != 2 {
		t.Fatalf("default scan: %+v, %v", report, err)
	}
	testTree(t, report, managed)
	all, err := Scan(context.Background(), Options{Root: root, Excludes: []string{}})
	if err != nil || len(all.Worktrees) != 4 {
		t.Fatalf("explicit scan-all: %+v, %v", all, err)
	}
	if !testTree(t, all, bare).Bare {
		t.Fatal("fixture did not reproduce an empty bare Codex repository")
	}
}

func TestGlobCodexScratchExcludesDiscoveryAndRegisteredWorktrees(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", root)
	repo := testRepo(t, filepath.Join(root, "repo"))
	for _, name := range []string{".codex", ".codex-alt"} {
		testLinked(t, repo, filepath.Join(root, name, ".tmp", "linked"), strings.TrimPrefix(name, ".")+"-scratch")
		testLinked(t, repo, filepath.Join(root, name, "worktrees", "feature"), strings.TrimPrefix(name, ".")+"-feature")
		testRepo(t, filepath.Join(root, name, ".tmp", "standalone"))
	}
	report, err := Scan(context.Background(), Options{Root: root, Excludes: []string{"~/.codex*/.tmp"}, Progress: func(event Progress) {
		if event.Worktree != nil && strings.Contains(event.Worktree.Path, "/.tmp/") {
			t.Errorf("glob-excluded worktree leaked into progress: %s", event.Worktree.Path)
		}
	}})
	if err != nil || len(report.Worktrees) != 3 {
		t.Fatalf("glob scratch scan: %+v, %v", report, err)
	}
	for _, name := range []string{".codex", ".codex-alt"} {
		testTree(t, report, filepath.Join(root, name, "worktrees", "feature"))
	}
}

func TestGlobExclusionComponentsAndAnchoring(t *testing.T) {
	root := filepath.Join(exclusionTempRoot(t), "scan")
	for _, tc := range []struct {
		rule string
		path string
		want bool
	}{
		{"cache*", "deep/cache-alt/repo", true},
		{"cache*", "deep/not-cache/repo", false},
		{"build?", "deep/build1/repo", true},
		{"build?", "deep/build12/repo", false},
		{"cache[0-3]", "deep/cache2/repo", true},
		{"cache[0-3]", "deep/cache5/repo", false},
		{"cache[^0-3]", "deep/cache5/repo", true},
		{"cache[^0-3]", "deep/cache2/repo", false},
		{"workspace*/cache?", "workspace-a/cache2/repo", true},
		{"workspace*/cache?", "deep/workspace-a/cache2/repo", false},
		{"workspace*/cache?", "workspace-a/cache12/repo", false},
		{"**/.tmp", ".tmp/repo", true},
		{"**/.tmp", "deep/very/deep/.tmp/repo", true},
		{"**/.tmp", "deep/worktrees/repo", false},
		{"workspace/**/scratch", "workspace/scratch/repo", true},
		{"workspace/**/scratch", "workspace/a/b/scratch/repo", true},
		{"workspace/**/scratch", "workspace2/a/scratch/repo", false},
		{"a/**/**/z", "a/z/repo", true},
		{"a/**/**/z", "a/b/c/z/repo", true},
		{"literal\\*", "literal*/repo", true},
		{"literal\\*", "literal-name/repo", false},
		{"cache\\[old\\]", "cache[old]/repo", true},
		{"cache\\[old\\]", "cacheo/repo", false},
	} {
		t.Run(tc.rule+"/"+tc.path, func(t *testing.T) {
			excluded, err := compileExcludes(root, []string{tc.rule})
			if err != nil {
				t.Fatal(err)
			}
			if got := excluded(filepath.Join(root, tc.path)); got != tc.want {
				t.Fatalf("%q match %q = %v, want %v", tc.rule, tc.path, got, tc.want)
			}
		})
	}
}

func TestGlobExclusionsKeepRootAndHomeMetacharactersLiteral(t *testing.T) {
	parent := exclusionTempRoot(t)
	root := filepath.Join(parent, "home[ab]*?")
	t.Setenv("HOME", root)
	for _, rule := range []string{"~/.codex*/.tmp", ".codex*/.tmp"} {
		excluded, err := compileExcludes(root, []string{rule})
		if err != nil {
			t.Fatal(err)
		}
		if !excluded(filepath.Join(root, ".codex-alt", ".tmp", "repo")) {
			t.Errorf("literal root/home didn't match for %q", rule)
		}
		if excluded(filepath.Join(parent, "homeaXY", ".codex-alt", ".tmp", "repo")) {
			t.Errorf("root/home metacharacters became glob for %q", rule)
		}
	}
}

func TestGlobExclusionsCanonicalizeLiteralSymlinkPrefix(t *testing.T) {
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	actual, alias := filepath.Join(parent, "actual"), filepath.Join(parent, "alias")
	if err := os.Mkdir(actual, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(actual, alias); err != nil {
		t.Fatal(err)
	}
	for _, rule := range []string{alias + "/.codex*/.tmp", alias + "/missing/.codex*/.tmp"} {
		excluded, err := compileExcludes(parent, []string{rule})
		if err != nil {
			t.Fatal(err)
		}
		path := strings.Replace(rule, alias, actual, 1)
		path = strings.Replace(path, ".codex*", ".codex-alt", 1)
		if !excluded(filepath.Join(path, "repo")) {
			t.Fatalf("symlink literal prefix failed for %q", rule)
		}
	}
}

func TestGlobExclusionsExplicitRootCanStillMatchDescendants(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".codex-alt", ".tmp")
	excluded, err := compileExcludes(root, []string{"~/**/.tmp"})
	if err != nil {
		t.Fatal(err)
	}
	if excluded(root) || excluded(filepath.Join(root, "repo")) || !excluded(filepath.Join(root, "nested", ".tmp", "repo")) {
		t.Fatal("explicit root override disabled descendants or excluded selected root")
	}
	excluded, err = compileExcludes(root, []string{"~/.codex*/.tmp"})
	if err != nil || excluded(filepath.Join(root, "repo")) {
		t.Fatalf("fixed-depth wildcard root override failed: %v", err)
	}
}

func TestGlobStarKeepsExplicitRootRepository(t *testing.T) {
	root := testRepo(t, filepath.Join(t.TempDir(), "repo"))
	testRepo(t, filepath.Join(root, "nested"))
	report, err := Scan(context.Background(), Options{Root: root, Excludes: []string{"*"}})
	if err != nil || len(report.Worktrees) != 1 {
		t.Fatalf("explicit root hidden by broad glob: %+v, %v", report, err)
	}
	w := testTree(t, report, root)
	if !w.Main || w.CanRemove {
		t.Fatalf("explicit root lost its protections: %+v", w)
	}
}

func TestGlobExclusionsRejectMalformedPatterns(t *testing.T) {
	root := exclusionTempRoot(t)
	for _, rule := range []string{"cache[", "cache[]", "cache[abc", "cache\\", "~/.codex[/.tmp", "**/bad[", "bad\\/child"} {
		if _, err := compileExcludes(root, []string{rule}); err == nil {
			t.Errorf("malformed pattern %q accepted", rule)
		}
	}
}

func TestRecursiveGlobMatcherHasBoundedWork(t *testing.T) {
	root := exclusionTempRoot(t)
	rule := strings.Repeat("**/", 150) + "absent"
	path := filepath.Join(root, strings.Repeat("deep/", 150), "repo")
	excluded, err := compileExcludes(root, []string{rule})
	if err != nil || excluded(path) {
		t.Fatalf("recursive glob mismatch: %v", err)
	}
}

func TestScanExclusionsWithSymlinkRootAndHome(t *testing.T) {
	parent := exclusionTempRoot(t)
	root, alias := filepath.Join(parent, "real"), filepath.Join(parent, "alias")
	repo := testRepo(t, filepath.Join(root, "repo"))
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", alias)
	visible := testLinked(t, repo, filepath.Join(root, ".codex-alt", "worktrees", "feature"), "feature")
	homeExcluded := testLinked(t, repo, filepath.Join(root, ".codex-alt", ".tmp", "scratch"), "scratch")
	relativeExcluded := testLinked(t, repo, filepath.Join(root, "workspace-one", "cache1", "linked"), "cached")
	absoluteExcluded := testRepo(t, filepath.Join(root, "absolute-cache", "repo"))
	rules := []string{"~/.codex*/.tmp", "workspace*/cache?", filepath.Join(alias, "absolute-*")}
	report, err := Scan(context.Background(), Options{Root: alias, Excludes: rules, Progress: func(event Progress) {
		if event.Worktree != nil && (event.Worktree.Path == homeExcluded || event.Worktree.Path == relativeExcluded || event.Worktree.Path == absoluteExcluded) {
			t.Errorf("excluded aliased worktree leaked into progress: %s", event.Worktree.Path)
		}
	}})
	if err != nil || report.Root != root || len(report.Worktrees) != 2 {
		t.Fatalf("scan with root/home aliases: %+v, %v", report, err)
	}
	testTree(t, report, visible)
	testTree(t, report, repo)
}
