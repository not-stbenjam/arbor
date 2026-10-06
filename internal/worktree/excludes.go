package worktree

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/stbenjam/arbor/internal/config"
)

// DefaultExcludes returns a fresh list so callers can edit their preferences.
func DefaultExcludes() []string {
	return config.Excludes()
}

// compileExcludes matches directories only, never files inside an inspected
// worktree. Exclusions affect discovery, not removal safety checks.
// Root and candidate paths use the canonical form produced by ResolveRoot,
// WalkDir, and Git. Rules may use symlink aliases; they are resolved once here,
// rather than adding filesystem lookups to every directory match.
func compileExcludes(root string, rules []string) (func(string) bool, error) {
	if rules == nil {
		rules = DefaultExcludes()
	}
	if err := ValidateExcludes(rules); err != nil {
		return nil, err
	}
	var names []excludeComponent
	var paths [][]excludeComponent
	for _, rule := range rules {
		if !strings.ContainsRune(rule, filepath.Separator) && rule != "~" {
			component, err := compileExcludeComponent(rule)
			if err != nil {
				return nil, fmt.Errorf("invalid scan exclusion %q: %w", rule, err)
			}
			names = append(names, component)
			continue
		}
		// Keep actual root/home components literal: a bracket or star in the
		// user's home directory must not turn into an accidental glob.
		base, pattern := root, rule
		if rule == "~" || strings.HasPrefix(rule, "~/") {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, err
			}
			base, pattern = home, strings.TrimPrefix(rule, "~/")
			if rule == "~" {
				pattern = ""
			}
		} else if filepath.IsAbs(rule) {
			base = string(filepath.Separator)
		}
		components := literalExcludeComponents(base)
		for _, part := range strings.Split(pattern, string(filepath.Separator)) {
			if part == "" || part == "." {
				continue
			}
			if part == ".." {
				if len(components) > 0 {
					components = components[:len(components)-1]
				}
				continue
			}
			component, err := compileExcludeComponent(part)
			if err != nil {
				return nil, fmt.Errorf("invalid scan exclusion %q: %w", rule, err)
			}
			components = append(components, component)
		}
		paths = append(paths, canonicalExcludePrefix(components))
	}
	rootParts := excludePathParts(root)
	return func(path string) bool {
		path = filepath.Clean(path)
		if path == root {
			return false
		}
		pathParts := excludePathParts(path)
		for _, pattern := range paths {
			if excludePathMatches(pattern, pathParts, rootParts) {
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
				if name.matches(part) {
					return true
				}
			}
		}
		return false
	}, nil
}

// ValidateExcludes checks flag syntax without resolving paths on either host.
func ValidateExcludes(rules []string) error {
	if len(rules) > config.MaxExcludes() {
		return fmt.Errorf("at most %d scan exclusions are supported", config.MaxExcludes())
	}
	for _, rule := range rules {
		if rule == "" || len(rule) > 4096 || strings.ContainsRune(rule, '\x00') {
			return fmt.Errorf("scan exclusions must be nonempty directory names or paths of at most 4096 bytes")
		}
		if rule == "." || rule == ".." {
			return fmt.Errorf("scan exclusion %q must name a directory", rule)
		}
		for _, part := range strings.Split(rule, string(filepath.Separator)) {
			if part == "" || part == "." || part == ".." {
				continue
			}
			if _, err := compileExcludeComponent(part); err != nil {
				return fmt.Errorf("invalid scan exclusion %q: %w", rule, err)
			}
		}
	}
	return nil
}
