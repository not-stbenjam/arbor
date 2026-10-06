package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestFilesHumanOutputQuotesPathsAndExplainsBounds(t *testing.T) {
	r := worktree.FilesReport{Path: "/work/a\nfolder", Counts: map[string]int{"ignored": 3}, Bytes: map[string]int64{"ignored": 1024}, SizeLowerBound: true, Entries: []worktree.FileEntry{{Kind: "ignored", Path: "bad\n\x1bfile", Directory: true, Files: 2, SizeBytes: 1024, SizeLowerBound: true}}}
	var out bytes.Buffer
	if err := printFiles(&out, r); err != nil {
		t.Fatal(err)
	}
	for _, wanted := range []string{printable(r.Path), printable(r.Entries[0].Path), "Ignored files (3)", "at least 1 KB", "at least 2 files", "and 2 more", "more than one heading"} {
		if !strings.Contains(out.String(), wanted) {
			t.Fatalf("missing %q: %s", wanted, &out)
		}
	}
	if strings.Contains(out.String(), "bad\n") || strings.Contains(out.String(), "\x1b") {
		t.Fatal("unsafe path output")
	}
}

func TestFilesFramedProgressLeavesStdoutUnchanged(t *testing.T) {
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "topic")
	cliTestGit(t, repo, "worktree", "add", "-b", "topic", target)
	if err := os.WriteFile(filepath.Join(target, "notes"), []byte("notes"), 0600); err != nil {
		t.Fatal(err)
	}
	plain, quiet, err := commandOutput(t, "files", target, "--json")
	if err != nil || quiet != "" {
		t.Fatal(err, quiet)
	}
	out, framed, err := commandOutput(t, "files", target, "--json", "--progress")
	if err != nil || plain != out {
		t.Fatal("stdout changed", err, plain, out)
	}
	lines := strings.Split(strings.TrimSpace(framed), "\n")
	if len(lines) < 3 {
		t.Fatal(framed)
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, worktree.ProgressPrefix) {
			t.Fatal(line)
		}
		var event worktree.Progress
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, worktree.ProgressPrefix)), &event); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(event.Stage, "files-") {
			t.Fatal(event)
		}
	}
}
