package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
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
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
