package main

import (
	"bytes"
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
