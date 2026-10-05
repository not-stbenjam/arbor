package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func commandOutput(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	err := execute(context.Background(), args, &stdout, &stderr)
	return stdout.String(), stderr.String(), err
}

func isolatedCommandEnvironment(t *testing.T) {
	t.Helper()
	// Help, completion, version, and argument validation must not need Git,
	// a desktop installation, SSH, or the real user's home directory.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
}

func TestCobraBareCommandShowsHelpWithoutSideEffects(t *testing.T) {
	isolatedCommandEnvironment(t)
	out, stderr, err := commandOutput(t)
	if err != nil || stderr != "" {
		t.Fatalf("bare command should successfully print help: %v, stderr=%q", err, stderr)
	}
	for _, required := range []string{"Usage:", "list", "clean", "remove", "gui", "completion"} {
		if !strings.Contains(out, required) {
			t.Errorf("bare-command help missing %q: %s", required, out)
		}
	}
}

func TestCobraCommandHelpIsDescriptiveAndHidesPlumbing(t *testing.T) {
	isolatedCommandEnvironment(t)
	for _, command := range []string{"list", "clean", "remove", "gui", "version"} {
		help, stderr, err := commandOutput(t, "help", command)
		if err != nil || stderr != "" {
			t.Fatalf("help %s: %v, %q", command, err, stderr)
		}
		flagHelp, flagErrors, err := commandOutput(t, command, "--help")
		if err != nil || flagErrors != "" || help != flagHelp {
			t.Fatalf("help %s differs from --help: %v, %q\n%s\n%s", command, err, flagErrors, help, flagHelp)
		}
		if !strings.Contains(help, "Usage:") || !strings.Contains(help, "arbor "+command) {
			t.Fatalf("missing command usage for %s: %s", command, help)
		}
		for _, hidden := range []string{"--target-only", "--watch-stdin", "--id", "--branch", "--discard-local", "--acknowledge", "--expect-missing", "--expect-empty", "--stats-session"} {
			if strings.Contains(help, hidden) {
				t.Errorf("internal flag %s leaked into %s help", hidden, command)
			}
		}
		if command == "list" {
			for _, required := range []string{"Examples:", "--path", "--exclude", "--json", "--progress", "--linked-only", "--quiet"} {
				if !strings.Contains(help, required) {
					t.Errorf("list help missing %q: %s", required, help)
				}
			}
		}
	}
}

func TestCobraVersionFormsAreIdentical(t *testing.T) {
	isolatedCommandEnvironment(t)
	out, stderr, err := commandOutput(t, "version")
	if err != nil || stderr != "" || !strings.Contains(out, version) {
		t.Fatalf("version: %q %q %v", out, stderr, err)
	}
	flagOut, flagStderr, err := commandOutput(t, "--version")
	if err != nil || flagStderr != "" || flagOut != out {
		t.Fatalf("--version differs: %q versus %q (%v, %q)", flagOut, out, err, flagStderr)
	}
}

func TestCobraHelpSkipsConfiguredPathsAndHosts(t *testing.T) {
	isolatedCommandEnvironment(t)
	for _, args := range [][]string{
		{"list", "--path", "/arbor-does-not-exist", "--help"},
		{"remove", "/arbor-does-not-exist", "--help"},
		{"gui", "--host", "not-a-real-host", "--help"},
		{"clean", "--all", "--yes", "--path", "/arbor-does-not-exist", "--help"},
	} {
		out, stderr, err := commandOutput(t, args...)
		if err != nil || stderr != "" || !strings.Contains(out, "Usage:") {
			t.Errorf("help performed work for %q: %v, %q, %q", args, err, out, stderr)
		}
	}
}

func TestCobraValidatesCommandsFlagsAndArgumentsBeforeIO(t *testing.T) {
	isolatedCommandEnvironment(t)
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"lsit"}, "unknown command"},
		{[]string{"list", "--not-an-arbor-flag"}, "unknown flag"},
		{[]string{"list", "unexpected"}, ""},
		{[]string{"clean", "unexpected"}, ""},
		{[]string{"gui", "unexpected"}, ""},
		{[]string{"version", "unexpected"}, ""},
		{[]string{"remove"}, ""},
		{[]string{"remove", "/one", "/two"}, ""},
	} {
		out, stderr, err := commandOutput(t, tc.args...)
		if err == nil {
			t.Errorf("invalid invocation succeeded: %q, %s %s", tc.args, out, stderr)
			continue
		}
		message := strings.ToLower(err.Error() + stderr)
		if tc.want != "" && !strings.Contains(message, tc.want) {
			t.Errorf("%q: expected %q, got %v %s", tc.args, tc.want, err, stderr)
		}
		if strings.Contains(message, "git is required") || strings.Contains(message, "native arbor app not found") || strings.Contains(message, "no such file or directory") {
			t.Errorf("validation for %q performed I/O first: %v %s", tc.args, err, stderr)
		}
		if tc.args[0] == "lsit" && (!strings.Contains(message, "did you mean") || !strings.Contains(message, "list")) {
			t.Errorf("unknown command omitted suggestion: %v %s", err, stderr)
		}
	}
}

func TestCobraCompletionSupportsCommonShellsWithoutGit(t *testing.T) {
	isolatedCommandEnvironment(t)
	for _, shell := range []string{"bash", "zsh", "fish", "powershell"} {
		out, stderr, err := commandOutput(t, "completion", shell)
		if err != nil || stderr != "" || len(out) < 100 || !strings.Contains(strings.ToLower(out), "arbor") {
			t.Errorf("completion %s: %v, output=%q, stderr=%q", shell, err, out, stderr)
		}
	}
}

func TestCobraListHumanProgressQuietAndEmptyResults(t *testing.T) {
	root := t.TempDir()
	out, stderr, err := commandOutput(t, "list", "-p", root)
	if err != nil || !strings.Contains(strings.ToLower(out), "no ") || !strings.Contains(strings.ToLower(out), "worktree") || stderr == "" {
		t.Fatalf("human scan should show activity and explicit empty state: out=%q stderr=%q err=%v", out, stderr, err)
	}
	if strings.Contains(stderr, worktree.ProgressPrefix) {
		t.Fatal("human scan exposed machine progress protocol")
	}
	quietOut, quietErr, err := commandOutput(t, "list", "-p", root, "-q")
	if err != nil || quietErr != "" || !strings.Contains(strings.ToLower(quietOut), "worktree") {
		t.Fatalf("quiet scan: out=%q stderr=%q err=%v", quietOut, quietErr, err)
	}
}

func TestCobraJSONProgressContractUnchanged(t *testing.T) {
	for _, progress := range []bool{false, true} {
		args := []string{"list", "-p", t.TempDir(), "--json"}
		if progress {
			args = append(args, "--progress")
		}
		out, stderr, err := commandOutput(t, args...)
		var report worktree.Report
		if err != nil || json.Unmarshal([]byte(out), &report) != nil || report.Worktrees == nil {
			t.Fatalf("JSON report polluted: %q (%v)", out, err)
		}
		if !progress {
			if stderr != "" {
				t.Errorf("JSON without progress emitted stderr: %q", stderr)
			}
			continue
		}
		if stderr == "" {
			t.Fatal("explicit progress produced no events")
		}
		for _, line := range strings.Split(strings.TrimSpace(stderr), "\n") {
			if !strings.HasPrefix(line, worktree.ProgressPrefix) || !json.Valid([]byte(strings.TrimPrefix(line, worktree.ProgressPrefix))) {
				t.Errorf("invalid machine progress frame: %q", line)
			}
		}
	}
}

func TestCobraExclusionArraysKeepLiteralCommasForListAndClean(t *testing.T) {
	root, repo := cliTestRepository(t)
	for index, name := range []string{"cache,archive", "cache", "archive"} {
		branch := []string{"comma", "cache", "archive"}[index]
		cliTestGit(t, repo, "worktree", "add", "-b", branch, filepath.Join(root, name, "linked"))
	}
	for _, command := range []string{"list", "clean"} {
		out, stderr, err := commandOutput(t, command, "-p", root, "--json", "--exclude", "cache,archive")
		if err != nil || stderr != "" {
			t.Fatalf("%s literal exclusion: %v, %q", command, err, stderr)
		}
		var report struct {
			Worktrees []worktree.Worktree `json:"worktrees"`
		}
		if err := json.Unmarshal([]byte(out), &report); err != nil || len(report.Worktrees) != 2 {
			t.Fatalf("%s split comma exclusion: %s (%v)", command, out, err)
		}
		for _, w := range report.Worktrees {
			if w.Branch == "comma" {
				t.Fatalf("%s failed to exclude literal comma directory: %+v", command, w)
			}
		}
	}
}

func TestCobraRemoveAcceptsInterspersedFlagsAndHiddenIdentity(t *testing.T) {
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "target")
	cliTestGit(t, repo, "worktree", "add", "-b", "topic", target)
	scan, stderr, err := commandOutput(t, "list", "--target-only", "--linked-only=true", "-p", target, "--json")
	var report worktree.Report
	if err != nil || stderr != "" || json.Unmarshal([]byte(scan), &report) != nil || len(report.Worktrees) != 1 {
		t.Fatalf("hidden target inspection: %s %s %v", scan, stderr, err)
	}
	w := report.Worktrees[0]
	out, stderr, err := commandOutput(t, "remove", target, "--json", "-y", "--discard-local", "--id", w.ID, "--branch", w.Branch, "--head", w.Head)
	var result worktree.RemovalResult
	if err != nil || stderr != "" || json.Unmarshal([]byte(out), &result) != nil || !result.Removed || result.Path != target {
		t.Fatalf("interspersed flags/hidden identity rejected: %s %s %v", out, stderr, err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("confirmed disposable worktree still exists: %v", err)
	}
}

func TestCobraRemoveHonorsDoubleDashSeparator(t *testing.T) {
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "--looks-like-a-flag")
	cliTestGit(t, repo, "worktree", "add", "-b", "topic", target)
	t.Chdir(root)
	out, stderr, err := commandOutput(t, "remove", "--json", "--", filepath.Base(target))
	var preview struct {
		DryRun    bool                `json:"dryRun"`
		Worktrees []worktree.Worktree `json:"worktrees"`
	}
	if err != nil || stderr != "" || json.Unmarshal([]byte(out), &preview) != nil || !preview.DryRun || len(preview.Worktrees) != 1 {
		t.Fatalf("-- separator preview failed: %s %s %v", out, stderr, err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal("separator preview removed worktree")
	}
}

func TestCLIMissingGitHasAnActionableError(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PATH", t.TempDir())
	out, _, err := commandOutput(t, "list", "-p", root, "-q")
	if err == nil || !strings.Contains(err.Error(), "Git was not found on PATH") || !strings.Contains(err.Error(), "Install Git 2.36") || out != "" {
		t.Fatalf("missing Git: out=%q err=%v", out, err)
	}
}

func TestCLIInaccessibleFolderDoesNotClaimGitIsMissing(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0700) })
	if _, err := os.ReadDir(root); err == nil {
		t.Skip("user can read mode-000 directories")
	}
	out, _, err := commandOutput(t, "list", "-p", root, "-q")
	if err == nil || !strings.Contains(err.Error(), "check that the folder is accessible") || strings.Contains(err.Error(), "Git is required") || out != "" {
		t.Fatalf("inaccessible folder: out=%q err=%v", out, err)
	}
}

func TestSSHExamplesKeepHomeExpansionOnTheRemoteHost(t *testing.T) {
	isolatedCommandEnvironment(t)
	for _, command := range []string{"", "clean"} {
		args := []string{"--help"}
		if command != "" {
			args = []string{command, "--help"}
		}
		out, _, err := commandOutput(t, args...)
		if err != nil || !strings.Contains(out, "--host my-vps --path '~/projects'") || strings.Contains(out, "--host my-vps --path ~/projects") {
			t.Fatalf("remote example expands locally: %v\n%s", err, out)
		}
	}
}
