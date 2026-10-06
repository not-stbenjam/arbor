package engine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stbenjam/arbor/internal/worktree"
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
		if _, err := Scan(context.Background(), "fixture-vps", worktree.Options{Root: w.Path, TargetOnly: true, LinkedOnly: linkedOnly, Repository: w.CommonDir, SafeIgnored: []string{"custom cache"}}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(command, "'--target-only'") || !strings.Contains(command, "'--linked-only="+strconv.FormatBool(linkedOnly)+"'") {
			t.Fatalf("target filtering lost over SSH: %s", command)
		}
		if !strings.Contains(command, "'--no-default-safe-ignored'") || !strings.Contains(command, "'--safe-ignored' 'custom cache'") {
			t.Fatal(command)
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
		result, err := RemoveWorktree(context.Background(), RemovalRequest{Host: "fixture-vps", Worktree: w, Options: worktree.RemovalOptions{ExpectedHead: w.Head, DiscardLocal: discard, SafeIgnored: []string{"custom cache"}}})
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
		if !strings.Contains(command, "'--no-default-safe-ignored'") || !strings.Contains(command, "'--safe-ignored' 'custom cache'") {
			t.Fatal(command)
		}
		if !strings.Contains(command, "'--repo' "+quote(w.CommonDir)) {
			t.Fatalf("removal repository hint lost over SSH: %s", command)
		}
	}
}

func TestRemovalResultFailureKeepsTargetAndError(t *testing.T) {
	w := worktree.Worktree{Path: "/protected/checkout", Head: strings.Repeat("a", 40)}
	result, err := RemoveWorktree(context.Background(), RemovalRequest{Host: "fixture-vps", Worktree: w, Options: worktree.RemovalOptions{ExpectedHead: w.Head}})
	if err == nil || result.Removed || result.Path != w.Path || result.Error != err.Error() {
		t.Fatalf("protected removal result: %+v, %v", result, err)
	}
}

func TestRemoteRemovalSuccessMustMatchRequestedPath(t *testing.T) {
	w := worktree.Worktree{ID: "fixture", Path: "/remote/session", Head: strings.Repeat("a", 40), Branch: "topic", CanRemove: true}
	for _, returnedPath := range []string{"/remote/other", ""} {
		t.Run(returnedPath, func(t *testing.T) {
			statsRemoteFixture(t, func(string) ([]byte, error) {
				return json.Marshal(worktree.RemovalResult{Path: returnedPath, Removed: true, RetainedBranch: "other-target-branch"})
			})
			result, err := RemoveWorktree(context.Background(), RemovalRequest{Host: "stats-fixture-vps", Worktree: w, Options: worktree.RemovalOptions{ExpectedHead: w.Head}})
			if err == nil || result.Removed || result.Path != w.Path || result.Error != err.Error() || result.RetainedBranch != "" {
				t.Fatalf("unbound success must not count as removal: %+v, %v", result, err)
			}
		})
	}
}

func TestRemoteRemovalPreservesMissingAndEmptyConsent(t *testing.T) {
	w := worktree.Worktree{ID: "confirmed-registration", Path: "/remote/session", CommonDir: "/remote/repo/.git", Head: strings.Repeat("a", 40), Branch: "topic", CanDiscard: true}
	var sent string
	statsRemoteFixture(t, func(command string) ([]byte, error) {
		sent = command
		return json.Marshal(worktree.RemovalResult{Path: w.Path, Removed: true})
	})
	for _, kind := range []string{"present", "missing", "empty"} {
		t.Run(kind, func(t *testing.T) {
			w.Missing = kind == "missing"
			w.Empty = kind == "empty"
			if _, err := RemoveWorktree(context.Background(), RemovalRequest{Host: "stats-fixture-vps", Worktree: w, SessionID: "shared-session", Options: worktree.RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true}}); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(sent, "'--expect-missing'") != w.Missing || strings.Contains(sent, "'--expect-empty'") != w.Empty {
				t.Fatalf("%s expectation lost across SSH: %s", kind, sent)
			}
			for _, expected := range []string{"'--head' " + quote(w.Head), "'--id' " + quote(w.ID), "'--branch' " + quote(w.Branch), "'--repo' " + quote(w.CommonDir), "'--stats-session' 'shared-session'", "'--discard-local'"} {
				if !strings.Contains(sent, expected) {
					t.Fatalf("existing removal contract changed (%s): %s", expected, sent)
				}
			}
		})
	}
}

func TestRemoteRemovalUsesOnlyBoundStructuredRefusals(t *testing.T) {
	w := worktree.Worktree{ID: "fixture", Path: "/remote/session", Head: strings.Repeat("a", 40), Branch: "topic", CanRemove: true}
	const actionable = "close older Arbor processes, then move aside /remote/repo/.git/arbor-cleanup.lock before retrying"
	for _, tc := range []struct {
		name, output string
		status       int
		transport    bool
		accepted     bool
	}{
		{name: "exact refusal", output: `{"path":"/remote/session","removed":false,"error":"` + actionable + `"}`, status: 1, accepted: true},
		{name: "wrong path", output: `{"path":"/remote/other","removed":false,"error":"untrusted detail"}`, status: 1},
		{name: "malformed", output: `{`, status: 1},
		{name: "claimed success", output: `{"path":"/remote/session","removed":true,"error":"untrusted detail"}`, status: 1},
		{name: "missing removed field", output: `{"path":"/remote/session","error":"untrusted detail"}`, status: 1},
		{name: "null removed field", output: `{"path":"/remote/session","removed":null,"error":"untrusted detail"}`, status: 1},
		{name: "empty error", output: `{"path":"/remote/session","removed":false,"error":"  "}`, status: 1},
		{name: "SSH transport status", output: `{"path":"/remote/session","removed":false,"error":"untrusted detail"}`, status: 255},
		{name: "untyped transport failure", output: `{"path":"/remote/session","removed":false,"error":"untrusted detail"}`, transport: true},
		{name: "oversized", output: `{"path":"/remote/session","removed":false,"error":"` + strings.Repeat("x", maxProgressLine) + `"}`, status: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failure := error(&sshExitError{host: "stats-fixture-vps", detail: "generic exit diagnostic", status: tc.status, cause: errors.New("fixture exit")})
			if tc.transport {
				failure = errors.New("SSH stats-fixture-vps: connection interrupted")
			}
			statsRemoteFixture(t, func(string) ([]byte, error) { return []byte(tc.output), failure })
			result, err := RemoveWorktree(context.Background(), RemovalRequest{Host: "stats-fixture-vps", Worktree: w, Options: worktree.RemovalOptions{ExpectedHead: w.Head}})
			if err == nil || result.Removed || result.Path != w.Path || result.Error != err.Error() {
				t.Fatalf("nonzero remote removal became success or changed identity: %+v %v", result, err)
			}
			if tc.accepted {
				if err.Error() != "stats-fixture-vps: "+actionable {
					t.Fatalf("actionable error lost: %v", err)
				}
			} else if !errors.Is(err, failure) {
				t.Fatalf("unvalidated output replaced transport diagnostic: %v", err)
			}
		})
	}
}

func TestRemoteRemovalPreservesActivityCutoff(t *testing.T) {
	w := worktree.Worktree{Path: "/remote/session", Head: strings.Repeat("a", 40), CanRemove: true}
	cutoff := time.Date(2026, 1, 2, 3, 4, 5, 123, time.UTC)
	statsRemoteFixture(t, func(command string) ([]byte, error) {
		if !strings.Contains(command, "'--not-active-since' "+quote(cutoff.Format(time.RFC3339Nano))) {
			t.Fatalf("cutoff lost: %s", command)
		}
		return json.Marshal(worktree.RemovalResult{Path: w.Path, Removed: true})
	})
	if _, err := RemoveWorktree(context.Background(), RemovalRequest{Host: "stats-fixture-vps", Worktree: w, Options: worktree.RemovalOptions{ExpectedHead: w.Head, NotActiveSince: cutoff}}); err != nil {
		t.Fatal(err)
	}
}
