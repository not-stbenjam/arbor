package engine

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

func TestRemoteTargetAndRemovalPolicyArguments(t *testing.T) {
	old, oldVersion := managed, Version
	t.Cleanup(func() { managed, Version = old, oldVersion })
	Version = "v1.2.3"
	var command string
	w := worktree.Worktree{ID: "fixture", Path: "/code/old session", Head: strings.Repeat("a", 40), Branch: "topic", CanRemove: true, CanDiscard: true}
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
				return json.Marshal(worktree.RemovalResult{Path: w.Path, Removed: true})
			default:
				t.Fatalf("unexpected command: %s", value)
				return nil, nil
			}
		},
	}
	if _, err := Scan(context.Background(), "fixture-vps", worktree.Options{Root: w.Path, TargetOnly: true, LinkedOnly: true}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(command, "'--target-only'") || !strings.Contains(command, "'--linked-only'") {
		t.Fatalf("target filtering lost over SSH: %s", command)
	}
	for _, discard := range []bool{false, true} {
		if err := RemoveWithOptions(context.Background(), "fixture-vps", w, w.Head, false, discard); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(command, "'--discard-local'") != discard || strings.Contains(command, "'--keep-local'") == discard {
			t.Fatalf("removal consent changed across SSH: %s", command)
		}
		if !strings.Contains(command, "'--' '/code/old session'") {
			t.Fatalf("target path not opaque: %s", command)
		}
	}
}
