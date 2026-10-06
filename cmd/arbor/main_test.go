package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestCLIProgressPreservesJSONStdout(t *testing.T) {
	for _, progress := range []bool{false, true} {
		var out, stderr bytes.Buffer
		args := []string{"list", "--path", t.TempDir(), "--json"}
		if progress {
			args = append(args, "--progress")
		}
		if err := execute(context.Background(), args, &out, &stderr); err != nil {
			t.Fatal(err)
		}
		var report worktree.Report
		if err := json.Unmarshal(out.Bytes(), &report); err != nil || report.Worktrees == nil {
			t.Fatalf("stdout is not a report: %q, %v", out.String(), err)
		}
		if !progress {
			if stderr.Len() != 0 {
				t.Fatalf("unexpected default progress: %q", stderr.String())
			}
			continue
		}
		lines := strings.Split(strings.TrimSpace(stderr.String()), "\n")
		if len(lines) < 2 {
			t.Fatalf("expected discovery and inspection: %q", stderr.String())
		}
		for _, line := range lines {
			if !strings.HasPrefix(line, worktree.ProgressPrefix) {
				t.Fatalf("unframed progress: %q", line)
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, worktree.ProgressPrefix)), &event); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"stage", "path", "discovered", "completed", "total"} {
				if _, ok := event[key]; !ok {
					t.Fatalf("missing progress field %q: %v", key, event)
				}
			}
		}
	}
}

func TestCLITableLabelsAbsentCheckouts(t *testing.T) {
	var out bytes.Buffer
	if err := printTable(&out, "", []worktree.Worktree{
		{Path: "/work/missing", Missing: true, CanDiscard: true},
		{Path: "/work/empty", Empty: true, CanDiscard: true},
	}); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"missing checkout", "empty checkout"} {
		if !strings.Contains(out.String(), expected) {
			t.Fatalf("missing status %q in %s", expected, out.String())
		}
	}
}

func TestCLITableShowsSizeAndTheDecidingStatus(t *testing.T) {
	var out bytes.Buffer
	if err := printTable(&out, "", []worktree.Worktree{
		{Path: "/work/merged", Merged: true, CanRemove: true, CanDiscard: true, Recommended: true, SizeBytes: 3 * 1024 * 1024},
		{Path: "/work/new", Merged: true, Fresh: true, CanRemove: true, CanDiscard: true, SizeBytes: 512},
		{Path: "/work/dirty", Merged: true, Dirty: true, CanDiscard: true, SizeBytes: 2048},
		{Path: "/work/gone", Missing: true, CanDiscard: true, SizeBytes: 4096},
	}); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 5 || !strings.Contains(lines[0], "SIZE") {
		t.Fatalf("unexpected table: %s", out.String())
	}
	for i, want := range [][]string{{"3 MB", "merged"}, {"512 B", "new"}, {"2 KB", "local changes"}, {"—", "missing checkout"}} {
		fields := strings.Fields(lines[i+1])
		row := strings.Join(fields, " ")
		for _, text := range want {
			if !strings.Contains(row, text) {
				t.Fatalf("row %q lacks %q", lines[i+1], text)
			}
		}
	}
	// A missing checkout occupies no disk, whatever an older scan measured.
	if got := totalSize([]worktree.Worktree{{SizeBytes: 10}, {SizeBytes: 5, Missing: true}}); got != 10 {
		t.Fatalf("total size counted a missing checkout: %d", got)
	}
	if count(1, "worktree") != "1 worktree" || count(2, "worktree") != "2 worktrees" || count(0, "worktree") != "0 worktrees" {
		t.Fatal("counts must agree in number")
	}
}

// Every path under the scanned folder repeats that folder. A table for people
// names it once; a long branch keeps both of its ends.
func TestCLITableNamesTheFolderOnceAndKeepsRowsNarrow(t *testing.T) {
	var out bytes.Buffer
	branch := "feature/checkout-redesign-with-a-rather-long-branch-name-for-truncation"
	if err := printTableWidth(&out, "/home/dev/code", []worktree.Worktree{
		{Path: "/home/dev/code/worktrees/api/login", Branch: "feature/login", Repo: "api", CanRemove: true, CanDiscard: true},
		{Path: "/home/dev/code/worktrees/web/checkout", Branch: branch, Repo: "web", CanRemove: true, CanDiscard: true},
		{Path: "/home/dev/codex/outside", Branch: "elsewhere", Repo: "api", CanRemove: true, CanDiscard: true},
		// Merged, but detached: clean does not take it, so it is not "merged".
		{Path: "/home/dev/code/sessions/one", Detached: true, Merged: true, CanDiscard: true},
	}, 110); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if lines[0] != "Under /home/dev/code:" || len(lines) != 6 {
		t.Fatalf("unexpected table: %s", out.String())
	}
	for i, want := range [][]string{
		{"worktrees/api/login", "feature/login"},
		{"worktrees/web/checkout", shorten(branch, 40)},
		{"/home/dev/codex/outside", "elsewhere"},
		// --yes alone does not take it, so it is not called clean.
		{"sessions/one", "(detached)", "detached"},
	} {
		fields := strings.Fields(lines[i+2])
		for j, text := range want[:2] {
			if i == 1 && j == 1 {
				continue
			}
			if fields[j] != text {
				t.Fatalf("row %d field %d = %q, want %q\n%s", i, j, fields[j], text, out.String())
			}
		}
		if len(want) == 3 && fields[len(fields)-1] != want[2] {
			t.Fatalf("row %d status = %q, want %q", i, fields[len(fields)-1], want[2])
		}
	}
	if strings.Contains(out.String(), branch) {
		t.Fatal("a long branch name widened every row")
	}
	for _, line := range lines {
		if len([]rune(line)) > 110 {
			t.Fatalf("row is too wide for a terminal: %d %q", len([]rune(line)), line)
		}
	}
	// One target named by its own path has nothing to be relative to.
	out.Reset()
	if err := printTable(&out, "/home/dev/code/one", []worktree.Worktree{{Path: "/home/dev/code/one", Branch: "topic"}}); err != nil || strings.Contains(out.String(), "Under ") || !strings.Contains(out.String(), "/home/dev/code/one") {
		t.Fatalf("single target: %v %s", err, out.String())
	}
	if got := shorten("short", 40); got != "short" {
		t.Fatalf("a short name changed: %q", got)
	}
	if got := shorten(strings.Repeat("é", 50), 40); len([]rune(got)) != 40 {
		t.Fatalf("shortening must count characters, not bytes: %d", len([]rune(got)))
	}
}

func TestCLICleanLeavesAWorktreeCreatedMomentsAgo(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	established, created := filepath.Join(root, "established"), filepath.Join(root, "created")
	cliTestGit(t, repo, "worktree", "add", "-b", "old-session", established)
	// Stamp this one checkout with the present, as a tool or person just did.
	cmd := exec.Command("git", "-C", repo, "worktree", "add", "-b", "new-session", created)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_COMMITTER_DATE=")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git worktree add: %v %s", err, out)
	}
	var out, stderr bytes.Buffer
	if err := execute(context.Background(), []string{"clean", "--path", root, "--yes"}, &out, &stderr); err != nil {
		t.Fatalf("clean: %v\n%s", err, &stderr)
	}
	if _, err := os.Stat(established); !os.IsNotExist(err) {
		t.Fatalf("established merged checkout was not cleaned: %v", err)
	}
	if _, err := os.Stat(created); err != nil {
		t.Fatalf("clean removed a checkout created moments ago: %v", err)
	}
	out.Reset()
	if err := execute(context.Background(), []string{"list", "--path", root, "--quiet"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "new") || strings.Contains(out.String(), "merged") {
		t.Fatalf("new checkout should be labelled new, not merged: %s", out.String())
	}
}

// Cleanup results carry no warnings of their own. A scan that could not read
// part of the folder must not look like a clean folder with nothing to remove.
func TestCLICleanReportsIncompleteScansInJSONMode(t *testing.T) {
	isolatedCLIStats(t)
	root, _ := cliTestRepository(t)
	broken := filepath.Join(root, "broken")
	if err := os.Mkdir(broken, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(broken, ".git"), []byte("gitdir: /nonexistent/arbor-fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	if err := execute(context.Background(), []string{"clean", "--path", root, "--json"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	var preview struct {
		DryRun    bool                `json:"dryRun"`
		Worktrees []worktree.Worktree `json:"worktrees"`
		Warnings  []string            `json:"warnings"`
	}
	if err := json.Unmarshal(out.Bytes(), &preview); err != nil || !preview.DryRun || len(preview.Warnings) != 1 || !strings.Contains(preview.Warnings[0], broken) {
		t.Fatalf("preview hides the incomplete scan: %s (%v)", out.String(), err)
	}
	if !strings.Contains(stderr.String(), "Warning:") || !strings.Contains(stderr.String(), broken) {
		t.Fatalf("stderr hides the incomplete scan: %q", stderr.String())
	}
	out.Reset()
	stderr.Reset()
	if err := execute(context.Background(), []string{"clean", "--path", root, "--json", "--yes"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != "[]" || !strings.Contains(stderr.String(), broken) {
		t.Fatalf("cleanup hides the incomplete scan: stdout %q stderr %q", out.String(), stderr.String())
	}
	// A JSON list already carries its warnings; stderr stays quiet for parsers.
	out.Reset()
	stderr.Reset()
	if err := execute(context.Background(), []string{"list", "--path", root, "--json"}, &out, &stderr); err != nil || stderr.Len() != 0 {
		t.Fatalf("JSON list wrote diagnostics: %q (%v)", stderr.String(), err)
	}
}

func TestCLICleanupPreviewsThenRemovesRetainingBranch(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0755); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Arbor Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Arbor Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init", "-b", "main")
	git("commit", "--allow-empty", "-m", "Initial")
	target := filepath.Join(root, "finished")
	git("worktree", "add", "-b", "finished", target)
	var out, stderr bytes.Buffer
	if err := execute(context.Background(), []string{"clean", "--path", root, "--json"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	var preview struct {
		DryRun    bool                `json:"dryRun"`
		Worktrees []worktree.Worktree `json:"worktrees"`
	}
	if err := json.Unmarshal(out.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if !preview.DryRun || len(preview.Worktrees) != 1 {
		t.Fatalf("bad preview: %s", out.String())
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("preview deleted worktree")
	}
	out.Reset()
	if err := execute(context.Background(), []string{"clean", "--path", root, "--json", "--yes"}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("cleanup did not remove target")
	}
	git("show-ref", "--verify", "refs/heads/finished")
	// Like git worktree remove, --yes alone never discards local files. The
	// preview says what --force would lose; only --force loses it.
	dirty := filepath.Join(root, "old-session")
	git("worktree", "add", "-b", "old-session", dirty)
	if err := os.WriteFile(filepath.Join(dirty, "scratch.txt"), []byte("local work"), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := execute(context.Background(), []string{"remove", "--json", "--", dirty}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	preview.Worktrees = nil
	var needsForce struct {
		RequiresForce bool `json:"requiresForce"`
	}
	if err := json.Unmarshal(out.Bytes(), &preview); err != nil || !preview.DryRun || len(preview.Worktrees) != 1 || !preview.Worktrees[0].CanDiscard {
		t.Fatalf("manual preview: %s (%v)", out.String(), err)
	}
	if err := json.Unmarshal(out.Bytes(), &needsForce); err != nil || !needsForce.RequiresForce {
		t.Fatalf("preview must say --yes alone will not remove this: %s (%v)", out.String(), err)
	}
	out.Reset()
	if err := execute(context.Background(), []string{"remove", "--", dirty}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"Uncommitted changes and untracked files will be deleted.", "Pass --force --yes to remove"} {
		if !strings.Contains(out.String(), text) {
			t.Fatalf("human preview omits %q: %s", text, out.String())
		}
	}
	if _, err := os.Stat(filepath.Join(dirty, "scratch.txt")); err != nil {
		t.Fatal("preview touched local file")
	}
	for _, args := range [][]string{{"remove", "--yes", "--", dirty}, {"remove", "--keep-local", "--yes", "--", dirty}, {"remove", "--json", "--yes", "--", dirty}} {
		out.Reset()
		err := execute(context.Background(), args, &out, &stderr)
		if err == nil || !strings.Contains(err.Error(), "--force") {
			t.Fatalf("%v discarded local work or did not say how to: %v", args, err)
		}
		if data, readErr := os.ReadFile(filepath.Join(dirty, "scratch.txt")); readErr != nil || string(data) != "local work" {
			t.Fatalf("%v touched local work: %q %v", args, data, readErr)
		}
	}
	out.Reset()
	if err := execute(context.Background(), []string{"remove", "--json", "--force", "--yes", "--", dirty}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dirty); !os.IsNotExist(err) {
		t.Fatal("explicit manual deletion did not remove worktree")
	}
	git("show-ref", "--verify", "refs/heads/old-session")
}

func TestCLIListLinkedOnlyExcludesOrdinaryRepository(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "kubernetes")
	if err := os.Mkdir(repo, 0755); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Arbor Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Arbor Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	git("init", "-b", "main")
	git("commit", "--allow-empty", "-m", "Initial")
	check := func(want int) {
		t.Helper()
		var out, stderr bytes.Buffer
		if err := execute(context.Background(), []string{"list", "--path", root, "--json", "--progress"}, &out, &stderr); err != nil {
			t.Fatal(err)
		}
		var report worktree.Report
		if err := json.Unmarshal(out.Bytes(), &report); err != nil || len(report.Worktrees) != want {
			t.Fatalf("unexpected linked worktrees: %s (%v)", out.String(), err)
		}
		for _, w := range report.Worktrees {
			if w.Main || w.Bare || w.Branch != "topic" {
				t.Fatalf("ordinary repository leaked into list: %+v", w)
			}
		}
		for _, line := range strings.Split(strings.TrimSpace(stderr.String()), "\n") {
			var event worktree.Progress
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, worktree.ProgressPrefix)), &event); err != nil {
				t.Fatal(err)
			}
			if event.Worktree != nil && (event.Worktree.Main || event.Worktree.Bare || filepath.Base(event.Worktree.Path) == "kubernetes") {
				t.Fatalf("ordinary repository leaked into progress: %+v", event.Worktree)
			}
		}
	}
	check(0)
	var includePrimary, includePrimaryErrors bytes.Buffer
	if err := execute(context.Background(), []string{"list", "--linked-only=false", "--path", root, "--json"}, &includePrimary, &includePrimaryErrors); err != nil {
		t.Fatal(err)
	}
	var allReport worktree.Report
	if err := json.Unmarshal(includePrimary.Bytes(), &allReport); err != nil || len(allReport.Worktrees) != 1 || !allReport.Worktrees[0].Main {
		t.Fatalf("explicit primary listing lost: %s (%v)", includePrimary.String(), err)
	}
	git("worktree", "add", "-b", "topic", filepath.Join(root, "worktrees", "topic"))
	check(1)
}

func cliTestGit(t *testing.T, repo string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", repo}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME=Arbor Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Arbor Test", "GIT_COMMITTER_EMAIL=test@example.com")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func cliTestRepository(t *testing.T) (string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	cliTestGit(t, repo, "init", "-b", "main")
	cliTestGit(t, repo, "commit", "--allow-empty", "-m", "Initial")
	return root, repo
}

func TestCLICleanAllWarningsIncludeExactPrintablePaths(t *testing.T) {
	root, repo := cliTestRepository(t)
	targets := []string{filepath.Join(root, "sessions", "one"), filepath.Join(root, "elsewhere", "one"), filepath.Join(root, "line\nbreak")}
	branches := []string{"first", "second", "third"}
	for i, target := range targets {
		cliTestGit(t, repo, "worktree", "add", "-b", branches[i], target)
		if err := os.WriteFile(filepath.Join(target, "local.txt"), []byte("local work"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var out, stderr bytes.Buffer
	// Without --force these are left alone, and the preview says how to
	// include them rather than listing them as about to go.
	if err := execute(context.Background(), []string{"clean", "--all", "--path", root}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "No matching worktrees to remove") || strings.Count(stderr.String(), "(add --force to include it)") != len(targets) {
		t.Fatalf("clean --all must skip worktrees with local files and say why:\n%s\n%s", out.String(), stderr.String())
	}
	out.Reset()
	stderr.Reset()
	if err := execute(context.Background(), []string{"clean", "--all", "--force", "--path", root}, &out, &stderr); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		if !strings.Contains(out.String(), printable(target)+": Uncommitted changes and untracked files will be deleted.") {
			t.Fatalf("warning missing unambiguous path %q: %s", target, out.String())
		}
		if _, err := os.Stat(filepath.Join(target, "local.txt")); err != nil {
			t.Fatal("clean --all preview touched local files")
		}
	}
}

func TestCLIRemovalReportsActualCommitRetention(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		detached, unreachable, json bool
	}{
		{name: "named branch"},
		{name: "detached already reachable", detached: true},
		{name: "detached recovery needed", detached: true, unreachable: true},
		{name: "reachable JSON", detached: true, json: true},
		{name: "recovery JSON", detached: true, unreachable: true, json: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, repo := cliTestRepository(t)
			target := filepath.Join(root, "target")
			if tc.detached {
				cliTestGit(t, repo, "worktree", "add", "--detach", target, "HEAD")
			} else {
				cliTestGit(t, repo, "worktree", "add", "-b", "topic", target)
			}
			if tc.unreachable {
				cliTestGit(t, target, "commit", "--allow-empty", "-m", "Detached-only work")
			}
			args := []string{"remove", "--yes"}
			if tc.detached {
				args = append(args, "--force")
			}
			if tc.json {
				args = append(args, "--json")
			}
			args = append(args, "--", target)
			var out, stderr bytes.Buffer
			if err := execute(context.Background(), args, &out, &stderr); err != nil {
				t.Fatal(err)
			}
			recovery := cliTestGit(t, repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/arbor/retained/")
			if (recovery != "") != tc.unreachable {
				t.Fatalf("unexpected recovery branch %q", recovery)
			}
			if tc.json {
				var result worktree.RemovalResult
				if err := json.Unmarshal(out.Bytes(), &result); err != nil || !result.Removed || result.Path != target || result.RetainedBranch != recovery {
					t.Fatalf("removal JSON lost retention: %s (%v)", out.String(), err)
				}
			} else {
				want := "(branch retained)"
				if recovery != "" {
					want = "(commit retained on " + recovery + ")"
				} else if tc.detached {
					want = "(commit retained)"
				}
				if !strings.Contains(out.String(), want) {
					t.Fatalf("human output lost retention %q: %s", want, out.String())
				}
			}
		})
	}
}

func TestCLIHelpDocumentsRemovalPolicies(t *testing.T) {
	for command, required := range map[string][]string{
		"remove": {"--force", "--repo", "that alone is refused", "uncommitted,\nuntracked or uncovered ignored files", "only when no\nbranch already holds them", "agrees to everything\nthe preview lists"},
		"clean":  {"--all", "--force", "not a clean delete are skipped\nunless --force is added", "another repository inside the folder", "Named branches and the checked-out commit are kept", "reflog or private refs are not protected"},
		"list":   {"--linked-only=false", "--exclude"},
	} {
		var out, stderr bytes.Buffer
		if err := execute(context.Background(), []string{command, "--help"}, &out, &stderr); err != nil {
			t.Fatal(err)
		}
		for _, text := range required {
			if !strings.Contains(out.String(), text) {
				t.Errorf("%s help omits %q", command, text)
			}
		}
	}
}

// The table's last column names the one thing that decides cleanup, including
// what only --force gets past.
func TestStatusNamesWhatForceIsNeededFor(t *testing.T) {
	for _, tc := range []struct {
		want  string
		entry worktree.Worktree
	}{
		{"not merged", worktree.Worktree{CanRemove: true, CanDiscard: true}},
		{"merged", worktree.Worktree{CanRemove: true, CanDiscard: true, Recommended: true}},
		{"ignored files", worktree.Worktree{CanDiscard: true, Ignored: true, Losses: []string{"ignored"}, Blockers: []string{"Ignored files on disk (may include local secrets or build output)"}}},
		{"unchecked files", worktree.Worktree{CanDiscard: true, Losses: []string{"unchecked"}, Blockers: []string{"Unchecked files: Git was told not to look at some files"}}},
		{"protected branch name", worktree.Worktree{CanDiscard: true, Blockers: []string{"Protected branch name"}}},
		{"detached", worktree.Worktree{CanDiscard: true, Detached: true, Blockers: []string{"Detached HEAD; create a branch to retain its commits"}}},
		// Nothing with something to lose is called clean, detached or not,
		// and the gravest loss is the one named.
		{"unfinished operation", worktree.Worktree{CanDiscard: true, Detached: true, Losses: []string{"operation"}, Blockers: []string{"Detached HEAD; create a branch to retain its commits", "Unfinished Git operation: a bisect is in progress"}}},
		{"nested repository", worktree.Worktree{CanDiscard: true, Dirty: true, Losses: []string{"changes", "nested"}}},
		{"submodules", worktree.Worktree{CanDiscard: true, Losses: []string{"ignored", "submodules", "operation"}}},
		{"Contains submodules", worktree.Worktree{Blockers: []string{"Contains submodules"}}},
	} {
		if got := status(tc.entry); got != tc.want {
			t.Errorf("status(%+v) = %q, want %q", tc.entry.Blockers, got, tc.want)
		}
	}
}

// With --progress, the deletion of a folder is reported as framed lines an
// integration can follow, and the result on stdout is unchanged.
func TestCLIRemoveStreamsDeletionProgress(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "finished")
	cliTestGit(t, repo, "worktree", "add", "-b", "finished", target)
	var out, stderr bytes.Buffer
	if err := execute(context.Background(), []string{"remove", "--yes", "--json", "--progress", "--", target}, &out, &stderr); err != nil {
		t.Fatalf("remove: %v\n%s", err, &stderr)
	}
	var result struct {
		Path    string `json:"path"`
		Removed bool   `json:"removed"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || !result.Removed || result.Path != target {
		t.Fatalf("result: %v %s", err, &out)
	}
	var deleting []worktree.Progress
	for _, line := range strings.Split(stderr.String(), "\n") {
		body, framed := strings.CutPrefix(line, worktree.ProgressPrefix)
		if !framed {
			continue
		}
		var event worktree.Progress
		if err := json.Unmarshal([]byte(body), &event); err != nil {
			t.Fatalf("progress line %q: %v", line, err)
		}
		if event.Stage == "remove" {
			deleting = append(deleting, event)
		}
	}
	// The only file in this checkout is its .git file.
	if len(deleting) == 0 || deleting[0].Path != target || deleting[0].FilesTotal != 1 {
		t.Fatalf("no deletion progress in:\n%s", &stderr)
	}
	// A person is told only about a deletion long enough to wonder about.
	second := filepath.Join(root, "quick")
	cliTestGit(t, repo, "worktree", "add", "-b", "quick", second)
	out.Reset()
	stderr.Reset()
	if err := execute(context.Background(), []string{"remove", "--yes", "--", second}, &out, &stderr); err != nil {
		t.Fatalf("remove: %v\n%s", err, &stderr)
	}
	if strings.Contains(stderr.String(), "gone") || strings.Contains(stderr.String(), worktree.ProgressPrefix) {
		t.Fatalf("a quick deletion was narrated:\n%s", &stderr)
	}
}

func TestHumanRemovalProgressWaitsThenSpeaksSparingly(t *testing.T) {
	var out bytes.Buffer
	report := removalProgress(&out, false, true)
	report(worktree.Progress{Stage: "remove", Files: 5, FilesTotal: 10, Current: "a"})
	if out.Len() != 0 {
		t.Fatalf("spoke at once: %q", &out)
	}
	if removalProgress(&out, false, false) != nil {
		t.Fatal("quiet mode should not watch the deletion at all")
	}
	var framed bytes.Buffer
	removalProgress(&framed, true, true)(worktree.Progress{Stage: "remove", Path: "/w", Files: 5, FilesTotal: 10, Current: "a/b"})
	if got := framed.String(); !strings.HasPrefix(got, worktree.ProgressPrefix) || !strings.Contains(got, `"current":"a/b"`) || !strings.Contains(got, `"files":5`) || !strings.Contains(got, `"filesTotal":10`) {
		t.Fatalf("framed progress: %q", got)
	}
}

// A person's --force agrees to everything the preview listed. An integration
// passes --discard-local, which agrees to losing files in the folder and to
// nothing graver unless it names what it showed its user.
func TestCLIGraveLossesMustBeNamedOrForced(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	nest := func(branch string) string {
		target := filepath.Join(root, branch)
		cliTestGit(t, repo, "worktree", "add", "-b", branch, target)
		if err := os.Mkdir(filepath.Join(target, "experiment"), 0700); err != nil {
			t.Fatal(err)
		}
		cliTestGit(t, filepath.Join(target, "experiment"), "init", "-b", "main")
		cliTestGit(t, filepath.Join(target, "experiment"), "commit", "--allow-empty", "-m", "Kept nowhere else")
		return target
	}
	run := func(args ...string) (string, string, error) {
		var out, stderr bytes.Buffer
		err := execute(context.Background(), args, &out, &stderr)
		return out.String(), stderr.String(), err
	}
	first := nest("first")
	// The preview says what would be lost and that --force is what it takes.
	out, _, err := run("remove", "--", first)
	if err != nil || !strings.Contains(out, "separate Git repository") || !strings.Contains(out, "--force --yes") {
		t.Fatalf("preview: %v\n%s", err, out)
	}
	for _, args := range [][]string{
		{"remove", "--yes", "--", first},
		{"remove", "--yes", "--discard-local", "--", first},
		{"remove", "--yes", "--discard-local", "--acknowledge", "submodules", "--", first},
	} {
		if _, _, err := run(args...); err == nil {
			t.Fatalf("%v deleted a worktree holding another repository", args)
		}
		if _, err := os.Stat(filepath.Join(first, "experiment", ".git")); err != nil {
			t.Fatalf("%v: the nested repository is gone", args)
		}
	}
	if _, _, err := run("remove", "--yes", "--discard-local", "--acknowledge", "everything", "--", first); err == nil || !strings.Contains(err.Error(), "--acknowledge accepts") {
		t.Fatalf("an unknown loss was accepted: %v", err)
	}
	if _, _, err := run("remove", "--yes", "--acknowledge", "nested", "--", first); err == nil || !strings.Contains(err.Error(), "--discard-local") {
		t.Fatalf("--acknowledge without --discard-local: %v", err)
	}
	if _, stderr, err := run("remove", "--yes", "--discard-local", "--acknowledge", "nested", "--", first); err != nil {
		t.Fatalf("named loss refused: %v\n%s", err, stderr)
	}
	second := nest("second")
	if _, stderr, err := run("remove", "--yes", "--force", "--", second); err != nil {
		t.Fatalf("--force refused: %v\n%s", err, stderr)
	}
	for _, target := range []string{first, second} {
		if _, err := os.Stat(target); !os.IsNotExist(err) {
			t.Fatalf("%s was not removed: %v", target, err)
		}
	}
}

func TestAbsentCheckoutStatusStillNamesHistoryAtRisk(t *testing.T) {
	for _, absent := range []worktree.Worktree{{Missing: true}, {Empty: true}} {
		for _, loss := range []struct{ key, label string }{{"submodules", "submodules"}, {"operation", "unfinished operation"}, {"nested", "nested repository"}} {
			w := absent
			w.CanDiscard = true
			w.Losses = []string{loss.key}
			var out bytes.Buffer
			if err := printTable(&out, "/fixture", []worktree.Worktree{w}); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), loss.label) || strings.Contains(out.String(), "missing checkout") || strings.Contains(out.String(), "empty checkout") {
				t.Fatalf("history loss hidden by absent folder: %s", out.String())
			}
		}
	}
}
