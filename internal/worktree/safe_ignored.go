package worktree

import (
	"fmt"
	"strings"

	"github.com/stbenjam/arbor/internal/config"
)

// DefaultSafeIgnored returns a fresh list of disposable generated-file rules.
func DefaultSafeIgnored() []string { return config.SafeIgnored() }

// Rules describe Git's entries, not their contents. A folder entry is atomic:
// a rule for node_modules/* does not cover Git's node_modules/ entry.
func compileSafeIgnored(rules []string) (func(string) string, error) {
	if rules == nil {
		rules = DefaultSafeIgnored()
	}
	if len(rules) > config.MaxExcludes() {
		return nil, fmt.Errorf("choose up to %d safe ignored rules", config.MaxExcludes())
	}
	patterns := make([][]excludeComponent, len(rules))
	for i, rule := range rules {
		if strings.TrimSpace(rule) == "" || len(rule) > 4096 || strings.ContainsRune(rule, 0) || strings.HasPrefix(rule, "/") || strings.HasPrefix(rule, "~/") {
			return nil, fmt.Errorf("invalid safe ignored rule %q: use a name or worktree-relative pattern", rule)
		}
		clean := strings.TrimSuffix(strings.TrimPrefix(rule, "./"), "/")
		if !strings.Contains(strings.TrimSuffix(rule, "/"), "/") {
			patterns[i] = append(patterns[i], excludeComponent{recursive: true})
		}
		for _, part := range strings.Split(clean, "/") {
			if part == "" || part == "." || part == ".." {
				return nil, fmt.Errorf("invalid safe ignored rule %q", rule)
			}
			component, err := compileExcludeComponent(part)
			if err != nil {
				return nil, fmt.Errorf("invalid safe ignored rule %q: %w", rule, err)
			}
			patterns[i] = append(patterns[i], component)
		}
	}
	return func(entry string) string {
		parts := strings.Split(strings.TrimSuffix(entry, "/"), "/")
		for i, pattern := range patterns {
			// Match the entire entry with bounded DP; never expand a folder on disk.
			current := make([]bool, len(parts)+1)
			current[0] = true
			for _, component := range pattern {
				next := make([]bool, len(parts)+1)
				for j := range current {
					if component.recursive {
						next[j] = current[j] || j > 0 && next[j-1]
					} else if j > 0 {
						next[j] = current[j-1] && component.matches(parts[j-1])
					}
				}
				current = next
			}
			if current[len(parts)] {
				return rules[i]
			}
		}
		return ""
	}, nil
}

func ValidateSafeIgnored(rules []string) error { _, err := compileSafeIgnored(rules); return err }
