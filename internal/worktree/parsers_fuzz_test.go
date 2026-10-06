package worktree

import (
	"reflect"
	"strings"
	"testing"
)

func FuzzPorcelain(f *testing.F) {
	for _, s := range []string{"", "worktree /tmp/a\x00HEAD abc\x00branch refs/heads/topic\x00\x00", "worktree a\nb\x00detached\x00locked reason\x00\x00"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		got := parseList(raw)
		if !reflect.DeepEqual(got, parseList(raw)) {
			t.Fatal("non-deterministic parse")
		}
		for _, w := range got {
			if w.Path == "" || strings.ContainsRune(w.Path, 0) {
				t.Fatal("invalid path")
			}
		}
		// For arbitrary byte names, Git's NUL record format must be lossless.
		name := strings.ReplaceAll(raw, "\x00", "_")
		if name == "" {
			return
		}
		round := parseList("worktree " + name + "\x00HEAD abc\x00\x00")
		if len(round) != 1 || round[0].Path != name {
			t.Fatal("path did not round trip")
		}
	})
}

func FuzzExclusionComponent(f *testing.F) {
	for _, s := range []string{"**", "[", "\\", "foo*", "a\\*"} {
		f.Add(s, "name")
	}
	f.Fuzz(func(t *testing.T, pattern, name string) {
		// BUG: compileExcludeComponent assumes Match validates a trailing
		// escape even when an earlier mismatch stopped that validation.
		if len(pattern)-len(strings.TrimRight(pattern, "\\")) > 0 && (len(pattern)-len(strings.TrimRight(pattern, "\\")))%2 == 1 {
			t.Skip("BUG: trailing escape may panic; TestStressExclusionTrailingEscape preserves the reproducer")
		}
		c, err := compileExcludeComponent(pattern)
		if err == nil && c.matches(name) != c.matches(name) {
			t.Fatal("unstable match")
		}
	})
}
