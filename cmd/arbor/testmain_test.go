package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// CLI tests perform real removals only in disposable fixtures. Keep their
// statistics equally isolated, including child processes used by watch tests.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "arbor-cli-test-stats-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.Setenv("ARBOR_STATS_PATH", filepath.Join(dir, "statistics.json")); err != nil {
		_ = os.RemoveAll(dir)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Fixtures model established checkouts: Git stamps a new worktree's HEAD
	// reflog with the committer date, and Arbor withholds cleanup recommendations
	// from a checkout created within the last day. Arbor's own Git commands
	// discard inherited GIT_* variables, so only fixture commands see this.
	if err := os.Setenv("GIT_COMMITTER_DATE", time.Now().Add(-48*time.Hour).Format(time.RFC3339)); err != nil {
		_ = os.RemoveAll(dir)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
