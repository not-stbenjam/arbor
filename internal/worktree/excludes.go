package worktree

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultExcludes returns a fresh list so callers can edit their preferences.
func DefaultExcludes() []string {
	return []string{".cache", ".Trash", "node_modules", "tmp", "temp", "~/Library/Caches", "~/Library/Logs", "~/.local/share/Trash", "~/.codex/.tmp"}
}

// compileExcludes matches directories only, never files inside an inspected
// worktree. Exclusions affect discovery, not removal safety checks.
func compileExcludes(root string, rules []string) (func(string) bool, error) {
	if rules == nil {
		rules = DefaultExcludes()
	}
	if len(rules) > 128 {
		return nil, fmt.Errorf("at most 128 scan exclusions are supported")
	}
	var names, paths []string
	for _, rule := range rules {
		if rule == "" || len(rule) > 4096 || strings.ContainsRune(rule, '\x00') {
			return nil, fmt.Errorf("scan exclusions must be nonempty directory names or paths of at most 4096 bytes")
		}
		if rule == "." || rule == ".." {
			return nil, fmt.Errorf("scan exclusion %q must name a directory", rule)
		}
		if !strings.ContainsRune(rule, filepath.Separator) && rule != "~" {
			names = append(names, rule)
			continue
		}
		path := rule
		if rule == "~" || strings.HasPrefix(rule, "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, err
			}
			path = filepath.Join(home, strings.TrimPrefix(rule, "~/"))
			if rule == "~" {
				path = home
			}
		} else if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		path = filepath.Clean(path)
		if canonical, err := filepath.EvalSymlinks(path); err == nil {
			path = canonical
		}
		// A deliberately selected root overrides an exclusion covering it.
		if !within(path, root) {
			paths = append(paths, path)
		}
	}
	return func(path string) bool {
		path = filepath.Clean(path)
		if path == root {
			return false
		}
		for _, excluded := range paths {
			if within(excluded, path) {
				return true
			}
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return false
		}
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			if part == ".." || part == "." {
				continue
			}
			for _, name := range names {
				if part == name {
					return true
				}
			}
		}
		return false
	}, nil
}
