package worktree

import (
	"errors"
	"path/filepath"
	"testing"
)

// A pattern ending in a lone backslash used to be read one character past
// its end. The input the fuzzer found is in testdata/stress.
func TestStressExclusionTrailingEscape(t *testing.T) {
	if _, err := compileExcludeComponent("0*\\"); err == nil {
		t.Fatal("malformed pattern accepted")
	}
}

// What is called well formed is what filepath.Match never rejects, whatever
// name it is given, and the other way about.
func TestWellFormedAgreesWithMatch(t *testing.T) {
	names := []string{"", "a", "ab", "abc", "a-c", "]", "[", "-", "\\", "aé", "0", "00", "é"}
	rejects := func(pattern string) bool {
		for _, name := range names {
			if _, err := filepath.Match(pattern, name); errors.Is(err, filepath.ErrBadPattern) {
				return true
			}
		}
		return false
	}
	for _, pattern := range []string{
		"", "a", "*", "?", "a*", "[a]", "[a-c]", "[^a]", "[^a-c]x", "[\\]]", "[a\\-]", "\\*", "a\\[", "[é-ü]", "*[ab]?", "[]a]", "[a-]", "[-a]", "[^]", "[^", "[", "[a", "[a-", "a\\", "\\", "[\\", "[a-\\", "0*\\", "[]", "[^]a]", "a]", "]",
	} {
		if good, bad := wellFormed(pattern), rejects(pattern); good == bad {
			t.Errorf("%q: called well formed = %v, but Match rejects it = %v", pattern, good, bad)
		}
	}
}
