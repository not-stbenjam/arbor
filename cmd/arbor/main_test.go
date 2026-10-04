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

	"github.com/not-stbenjam/arbor/internal/worktree"
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
	// Manual deletion matches the GUI: local files are described in preview,
	// and --yes confirms disposal without requiring an extra force flag.
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
	if err := json.Unmarshal(out.Bytes(), &preview); err != nil || !preview.DryRun || len(preview.Worktrees) != 1 || !preview.Worktrees[0].CanDiscard {
		t.Fatalf("manual preview: %s (%v)", out.String(), err)
	}
	if _, err := os.Stat(filepath.Join(dirty, "scratch.txt")); err != nil {
		t.Fatal("preview touched local file")
	}
	out.Reset()
	if err := execute(context.Background(), []string{"remove", "--keep-local", "--yes", "--", dirty}, &out, &stderr); err == nil {
		t.Fatal("keep-local discarded local work")
	}
	out.Reset()
	if err := execute(context.Background(), []string{"remove", "--json", "--yes", "--", dirty}, &out, &stderr); err != nil {
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
	if err := execute(context.Background(), []string{"clean", "--all", "--path", root}, &out, &stderr); err != nil {
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
	for _, required := range []string{"--keep-local", "--discard-local", "Explicit alias", "--linked-only=false", "only when no branch retains the commit"} {
		if !strings.Contains(help, required) {
			t.Errorf("help omits %q", required)
		}
	}
}
