package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestListClosingLine(t *testing.T) {
	report := worktree.Report{Root: "/fixture/code", Worktrees: []worktree.Worktree{
		{Path: "/fixture/code/a", SizeBytes: 100, Recommended: true},
		{Path: "/fixture/code/b", SizeBytes: 200, CanRemove: true},
	}}
	for _, recommended := range []bool{false, true} {
		var out bytes.Buffer
		if err := writeList(&out, worktreeRequest{recommended: recommended}, report); err != nil {
			t.Fatal(err)
		}
		want := "2 worktrees, 300 B. 1 can be deleted now (100 B): arbor clean --path /fixture/code\n"
		if recommended {
			want = "1 of 2 worktrees shown, 100 B. 1 can be deleted now (100 B): arbor clean --path /fixture/code\n"
		}
		if !strings.HasSuffix(out.String(), want) {
			t.Fatalf("%s", &out)
		}
	}
	report.Worktrees = report.Worktrees[1:]
	var out bytes.Buffer
	if err := writeList(&out, worktreeRequest{}, report); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(out.String(), "1 worktree, 200 B.\n") || strings.Contains(out.String(), "arbor clean") {
		t.Fatalf("%s", &out)
	}
}

func TestListHintKeepsHostAgeAndExclusions(t *testing.T) {
	var out bytes.Buffer
	r := worktreeRequest{host: "fixture-host", olderThan: ageDuration(30 * 24 * time.Hour), scan: worktree.Options{Excludes: []string{"cache*"}}}
	report := worktree.Report{Root: "/fixture/a b'c", Worktrees: []worktree.Worktree{{Recommended: true}}}
	if err := writeListSummary(&out, r, report, 1); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`--path '/fixture/a b'"'"'c'`, `--host fixture-host`, `--older-than 720h0m0s`, `--no-default-excludes --exclude 'cache*'`} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q: %s", want, &out)
		}
	}
}
