package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

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
}
