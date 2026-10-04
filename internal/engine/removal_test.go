package engine

import (
	"context"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"testing"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

func TestRemoteTargetAndRemovalPolicyArguments(t *testing.T) {
	old, oldVersion := managed, Version
	t.Cleanup(func() { managed, Version = old, oldVersion })
	Version = "v1.2.3"
	var command string
	retainedBranch := "arbor/retained/fixture"
	w := worktree.Worktree{ID: "fixture", Path: "/code/old session", CommonDir: "/code/repo's data/.git", Head: strings.Repeat("a", 40), Branch: "topic", CanRemove: true, CanDiscard: true}
	managed = &provisioner{
		run: func(_ context.Context, host, value string, _ io.Reader) ([]byte, error) {
			if host != "fixture-vps" {
				t.Fatalf("unexpected host %q", host)
			}
			switch {
			case value == "uname -s && uname -m":
				return []byte("Linux\naarch64\n"), nil
			case strings.Contains(value, "--version"):
				return []byte("arbor v1.2.3\n"), nil
			case strings.Contains(value, "'list'"):
				command = value
				return json.Marshal(worktree.Report{Root: w.Path, Worktrees: []worktree.Worktree{w}})
			case strings.Contains(value, "'remove'"):
				command = value
				return json.Marshal(worktree.RemovalResult{Path: w.Path, Removed: true, RetainedBranch: retainedBranch})
			default:
				t.Fatalf("unexpected command: %s", value)
				return nil, nil
			}
		},
	}
	for _, linkedOnly := range []bool{false, true} {
		if _, err := Scan(context.Background(), "fixture-vps", worktree.Options{Root: w.Path, TargetOnly: true, LinkedOnly: linkedOnly, Repository: w.CommonDir}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(command, "'--target-only'") || !strings.Contains(command, "'--linked-only="+strconv.FormatBool(linkedOnly)+"'") {
			t.Fatalf("target filtering lost over SSH: %s", command)
		}
		if !strings.Contains(command, "'--repo' "+quote(w.CommonDir)) {
			t.Fatalf("repository hint lost over SSH: %s", command)
		}
	}
	for _, discard := range []bool{false, true} {
		retainedBranch = ""
		if discard {
			retainedBranch = "arbor/retained/fixture"
		}
		result, err := RemoveWithResult(context.Background(), "fixture-vps", w, w.Head, false, discard)
		if err != nil {
			t.Fatal(err)
		}
		if result.RetainedBranch != retainedBranch || !result.Removed || result.Path != w.Path {
			t.Fatalf("remote recovery branch/result was lost: %+v", result)
		}
		if strings.Contains(command, "'--discard-local'") != discard || strings.Contains(command, "'--keep-local'") == discard {
			t.Fatalf("removal consent changed across SSH: %s", command)
		}
		if !strings.Contains(command, "'--' '/code/old session'") {
			t.Fatalf("target path not opaque: %s", command)
		}
		if !strings.Contains(command, "'--repo' "+quote(w.CommonDir)) {
			t.Fatalf("removal repository hint lost over SSH: %s", command)
		}
	}
}

func TestRemovalResultFailureKeepsTargetAndError(t *testing.T) {
	w := worktree.Worktree{Path: "/protected/checkout", Head: strings.Repeat("a", 40)}
	result, err := RemoveWithResult(context.Background(), "fixture-vps", w, w.Head, false, false)
	if err == nil || result.Removed || result.Path != w.Path || result.Error != err.Error() {
		t.Fatalf("protected removal result: %+v, %v", result, err)
	}
}
