package worktree

import "testing"

func TestStressExclusionTrailingEscape(t *testing.T) {
	t.Skip("BUG: compileExcludeComponent(0*\\) panics at exclude_glob.go:30; original fuzz input in testdata/stress/exclusion-panic.txt; CLI reproducer scripts/stress/bugs/exclude-panic.cjs")
	if _, err := compileExcludeComponent("0*\\"); err == nil {
		t.Fatal("malformed pattern accepted")
	}
}
