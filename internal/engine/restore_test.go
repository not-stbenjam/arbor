package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestRemoteRestore(t *testing.T) {
	o := worktree.RestoreOptions{Path: "/code/old 'session", CommonDir: "/code/repo/.git", Branch: "topic", Head: strings.Repeat("a", 40)}
	for _, detached := range []bool{false, true} {
		t.Run(map[bool]string{false: "branch", true: "detached"}[detached], func(t *testing.T) {
			request := o
			if detached {
				request.Branch = ""
				request.Detach = o.Head
			}
			statsRemoteFixture(t, func(command string) ([]byte, error) {
				for _, arg := range []string{"'restore' '--json'", "'--repo' " + quote(o.CommonDir), "'--head' " + quote(o.Head), "'--' " + quote(o.Path)} {
					if !strings.Contains(command, arg) {
						t.Fatal(command)
					}
				}
				if detached && !strings.Contains(command, "'--detach' "+quote(o.Head)) {
					t.Fatal(command)
				}
				return json.Marshal(worktree.RestoreResult{Path: o.Path, Branch: request.Branch, Head: o.Head, Restored: true})
			})
			r, err := Restore(context.Background(), "stats-fixture-vps", request)
			if err != nil || !r.Restored {
				t.Fatalf("%+v %v", r, err)
			}
		})
	}
}
func TestRemoteRestoreDoesNotAcceptUnconfirmedSuccess(t *testing.T) {
	o := worktree.RestoreOptions{Path: "/code/topic", CommonDir: "/code/repo/.git", Branch: "topic"}
	for _, kind := range []string{"wrong path", "wrong branch", "false", "malformed", "refusal", "transport", "success on nonzero"} {
		t.Run(kind, func(t *testing.T) {
			statsRemoteFixture(t, func(string) ([]byte, error) {
				r := worktree.RestoreResult{Path: o.Path, Branch: o.Branch, Head: strings.Repeat("a", 40), Restored: true}
				var err error
				switch kind {
				case "wrong path":
					r.Path = "/other"
				case "wrong branch":
					r.Branch = "other"
				case "false":
					r.Restored = false
				case "malformed":
					return []byte("not json"), nil
				case "refusal":
					r.Restored = false
					r.Error = "destination occupied"
					err = &sshExitError{status: 1}
				case "transport":
					r.Restored = false
					r.Error = "not a trusted refusal"
					err = &sshExitError{status: 255}
				case "success on nonzero":
					err = errors.New("connection lost")
				}
				data, _ := json.Marshal(r)
				return data, err
			})
			r, err := Restore(context.Background(), "stats-fixture-vps", o)
			if err == nil || r.Restored || r.Path != o.Path || r.Error == "" {
				t.Fatalf("%+v %v", r, err)
			}
			if kind == "refusal" && !strings.Contains(r.Error, "destination occupied") {
				t.Fatal(r.Error)
			}
			if kind == "transport" && strings.Contains(r.Error, "not a trusted refusal") {
				t.Fatal(r.Error)
			}
		})
	}
}
