package engine

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestFilesRemoteArgumentsAndResponse(t *testing.T) {
	old, version := managed, Version
	t.Cleanup(func() { managed, Version = old, version })
	Version = "v1.2.3"
	path, repo := "/work/a ' quoted\nfolder", "/work/repo/.git"
	report := worktree.FilesReport{Path: path, Head: strings.Repeat("a", 40), Branch: "topic", Counts: map[string]int{}, Bytes: map[string]int64{}, Entries: []worktree.FileEntry{}}
	var command string
	managed = &provisioner{run: func(_ context.Context, host, value string, _ io.Reader) ([]byte, error) {
		if host != "fixture-host" {
			t.Fatalf("host=%q", host)
		}
		if value == "uname -s && uname -m" {
			return []byte("Linux\naarch64\n"), nil
		}
		if strings.Contains(value, "--version") {
			return []byte("arbor v1.2.3\n"), nil
		}
		command = value
		return json.Marshal(report)
	}}
	result, err := Files(context.Background(), "fixture-host", path, repo, 7)
	if err != nil || result.Path != path {
		t.Fatalf("%+v %v", result, err)
	}
	for _, part := range []string{"'files' '--json' '--watch-stdin' '--limit' '7'", "'--repo' " + quote(repo), "'--' " + quote(path)} {
		if !strings.Contains(command, part) {
			t.Fatalf("missing %q: %s", part, command)
		}
	}
	// The remote owns path expansion and canonicalization, as it does for list.
	report.Path = "/resolved/worktree"
	if result, err := Files(context.Background(), "fixture-host", "~/worktree", repo, 7); err != nil || result.Path != report.Path {
		t.Fatalf("remote path resolution: %+v, %v", result, err)
	}
	var events []worktree.Progress
	managed.stream = func(_ context.Context, host, value string, _ io.Reader, reportProgress func(worktree.Progress)) ([]byte, error) {
		if !strings.Contains(value, "'--progress'") || !strings.Contains(value, "'--watch-stdin'") {
			t.Fatal(value)
		}
		for _, stage := range []string{"files-git", "files-search", "files-measure"} {
			reportProgress(worktree.Progress{Stage: stage, Path: path})
		}
		return json.Marshal(report)
	}
	if _, err := Files(context.Background(), "fixture-host", path, repo, 7, func(p worktree.Progress) { events = append(events, p) }); err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 || events[0].Stage != "connecting" || events[3].Stage != "files-measure" {
		t.Fatal(events)
	}
	report.Entries = nil
	if _, err := Files(context.Background(), "fixture-host", path, repo, 7); err == nil {
		t.Fatal("accepted incomplete result")
	}
}
