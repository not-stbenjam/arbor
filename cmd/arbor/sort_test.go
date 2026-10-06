package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestSortListAndPreviewJSON(t *testing.T) {
	entries := []worktree.Worktree{
		{Path: "a", SizeBytes: 10, ActivityAt: time.Unix(20, 0)},
		{Path: "b", SizeBytes: 30},
		{Path: "c", SizeBytes: 30, ActivityAt: time.Unix(10, 0)},
	}
	for order, want := range map[string][]string{"name": {"a", "b", "c"}, "size": {"b", "c", "a"}, "activity": {"c", "a", "b"}} {
		for _, preview := range []bool{false, true} {
			var out bytes.Buffer
			r := worktreeRequest{json: true, sortOrder: order}
			report := worktree.Report{Worktrees: entries}
			var err error
			if preview {
				err = writePreview(&out, r, report, targetSelection{selected: entries})
			} else {
				err = writeList(&out, r, report)
			}
			if err != nil {
				t.Fatal(err)
			}
			var result worktree.Report
			if err = json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, w := range result.Worktrees {
				got = append(got, w.Path)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s preview=%v: %v", order, preview, got)
			}
			if entries[0].Path != "a" {
				t.Fatal("presentation mutated the scan")
			}
		}
	}
	for _, command := range []string{"list", "clean"} {
		if _, _, err := commandOutput(t, command, "--sort", "bogus"); err == nil {
			t.Fatal("accepted unknown sort")
		}
	}
}
