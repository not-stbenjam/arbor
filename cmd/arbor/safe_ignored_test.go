package main

import (
	"github.com/stbenjam/arbor/internal/worktree"
	"slices"
	"testing"
)

func TestSafeIgnoredFlags(t *testing.T) {
	for _, command := range []string{"list", "clean", "remove", "files"} {
		root := newRootCommand(nil, nil)
		cmd, _, err := root.Find([]string{command})
		if err != nil {
			t.Fatal(err)
		}
		for _, flag := range []string{"safe-ignored", "no-default-safe-ignored"} {
			if cmd.Flags().Lookup(flag) == nil {
				t.Fatalf("%s lacks %s", command, flag)
			}
		}
	}
	for _, command := range []string{"list", "clean", "remove"} {
		r, err := normalizeRequest(command, &commandOptions{safeIgnored: []string{"custom", "*.cache"}})
		if err != nil || !slices.Equal(r.scan.SafeIgnored, append(worktree.DefaultSafeIgnored(), "custom", "*.cache")) {
			t.Fatalf("%+v %v", r, err)
		}
		r, err = normalizeRequest(command, &commandOptions{noDefaultSafeIgnored: true, safeIgnored: []string{"custom"}})
		if err != nil || !slices.Equal(r.scan.SafeIgnored, []string{"custom"}) {
			t.Fatalf("%+v %v", r, err)
		}
		r, err = normalizeRequest(command, &commandOptions{noDefaultSafeIgnored: true})
		if err != nil || r.scan.SafeIgnored == nil || len(r.scan.SafeIgnored) != 0 {
			t.Fatalf("%+v %v", r, err)
		}
	}
}
