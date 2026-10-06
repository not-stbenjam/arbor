package main

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestTableFitsTerminalAndPreservesRedirectedValues(t *testing.T) {
	path := "/fixture/" + strings.Repeat("long-path-", 12) + "ending"
	branch := "feature/" + strings.Repeat("界é", 40) + "ending"
	entries := []worktree.Worktree{{Path: path, Branch: branch, Repo: "service", SizeBytes: 123, Recommended: true}, {Path: "/fixture/short", Branch: "short", Repo: "service", SizeBytes: 1, Recommended: true}}
	for _, width := range []int{50, 60, 80, 120} {
		var out bytes.Buffer
		if err := printTableWidth(&out, "/fixture", entries, width); err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(out.String(), "\n") {
			if textWidth(line) > width {
				t.Fatalf("width %d: %q", width, line)
			}
		}
		if !strings.Contains(out.String(), "nding") || !strings.Contains(out.String(), "…") {
			t.Fatalf("lost ends: %s", &out)
		}
		if (width < 60) != strings.Contains(out.String(), "Branch:") {
			t.Fatalf("wrong layout at %d: %s", width, &out)
		}
		if width >= 60 {
			var ends []int
			for _, line := range strings.Split(out.String(), "\n") {
				if i := strings.Index(line, " B  "); i >= 0 {
					ends = append(ends, textWidth(line[:i+2]))
				}
			}
			if len(ends) != 2 || ends[0] != ends[1] {
				t.Fatalf("sizes not right aligned: %s", &out)
			}
		}
	}
	t.Setenv("COLUMNS", "20")
	var out bytes.Buffer
	if err := printTable(&out, "/fixture", entries); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), strings.TrimPrefix(path, "/fixture/")) || !strings.Contains(out.String(), branch) {
		t.Fatalf("redirected output shortened: %s", &out)
	}
}

func TestLongDiagnosticsRemainCompleteInBlocks(t *testing.T) {
	problem := strings.Repeat("unreadable metadata ", 10)
	var out bytes.Buffer
	if err := printTableWidth(&out, "", []worktree.Worktree{{Path: "/fixture/a", Blockers: []string{problem}}}, 80); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Status:") {
		t.Fatal("long diagnostic should use a block")
	}
	if !strings.Contains(strings.ReplaceAll(out.String(), "\n", ""), problem) {
		t.Fatalf("diagnostic lost: %s", &out)
	}
}

func TestTerminalWidthIgnoresColumnsForFiles(t *testing.T) {
	t.Setenv("COLUMNS", "80")
	file, err := os.CreateTemp(t.TempDir(), "output")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if terminalWidth(file) != 0 {
		t.Fatal("file treated as terminal")
	}
	for _, tc := range []struct {
		columns        string
		measured, want int
	}{{"80", 120, 80}, {"", 120, 120}, {"bad", 0, 100}, {"-1", 0, 100}} {
		if got := preferredWidth(tc.columns, tc.measured); got != tc.want {
			t.Fatalf("%+v: %d", tc, got)
		}
	}
}
