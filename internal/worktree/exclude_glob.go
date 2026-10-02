package worktree

import (
	"path/filepath"
	"strings"
)

type excludeComponent struct {
	text      string
	glob      bool
	recursive bool
}

func compileExcludeComponent(pattern string) (excludeComponent, error) {
	if _, err := filepath.Match(pattern, ""); err != nil {
		return excludeComponent{}, err
	}
	if pattern == "**" {
		return excludeComponent{recursive: true}, nil
	}
	var literal strings.Builder
	glob := false
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '\\':
			i++ // Validated above, so an escaped character always follows.
		case '*', '?', '[':
			glob = true
		}
		literal.WriteByte(pattern[i])
	}
	if glob {
		return excludeComponent{text: pattern, glob: true}, nil
	}
	return excludeComponent{text: literal.String()}, nil
}

func (component excludeComponent) matches(name string) bool {
	if component.recursive {
		return true
	}
	if !component.glob {
		return component.text == name
	}
	matched, _ := filepath.Match(component.text, name)
	return matched
}

func excludePathParts(path string) []string {
	clean := strings.Trim(filepath.Clean(path), string(filepath.Separator))
	if clean == "" {
		return nil
	}
	return strings.Split(clean, string(filepath.Separator))
}

func literalExcludeComponents(path string) []excludeComponent {
	var components []excludeComponent
	for _, part := range excludePathParts(path) {
		components = append(components, excludeComponent{text: part})
	}
	return components
}

// Canonicalize only the existing literal prefix, never expanding a glob. This
// handles macOS /var -> /private/var and aliases even when the rest is missing.
func canonicalExcludePrefix(components []excludeComponent) []excludeComponent {
	literalCount := 0
	var parts []string
	for _, component := range components {
		if component.glob || component.recursive {
			break
		}
		literalCount++
		parts = append(parts, component.text)
	}
	for count := literalCount; count > 0; count-- {
		prefix := string(filepath.Separator) + filepath.Join(parts[:count]...)
		if canonical, err := filepath.EvalSymlinks(prefix); err == nil {
			result := literalExcludeComponents(canonical)
			return append(result, components[count:]...)
		}
	}
	return components
}

// Match directory prefixes using bounded dynamic programming, not recursive
// wildcard backtracking. ** consumes zero or more complete path components.
// An accepted prefix excludes its entire subtree, unless that prefix is the
// selected root or an ancestor of it. The same glob may still match below root.
func excludePathMatches(pattern []excludeComponent, path, root []string) bool {
	commonRootDepth := 0
	for commonRootDepth < len(path) && commonRootDepth < len(root) && path[commonRootDepth] == root[commonRootDepth] {
		commonRootDepth++
	}
	recursive := false
	for _, component := range pattern {
		recursive = recursive || component.recursive
	}
	// All defaults and ordinary component-glob paths avoid DP allocations.
	if !recursive {
		if len(pattern) > len(path) || len(pattern) <= commonRootDepth {
			return false
		}
		for index, component := range pattern {
			if !component.matches(path[index]) {
				return false
			}
		}
		return true
	}
	current, next := make([]bool, len(path)+1), make([]bool, len(path)+1)
	current[0] = true
	for _, component := range pattern {
		clear(next)
		if component.recursive {
			for depth := range current {
				next[depth] = current[depth] || (depth > 0 && next[depth-1])
			}
		} else {
			for depth := 1; depth <= len(path); depth++ {
				next[depth] = current[depth-1] && component.matches(path[depth-1])
			}
		}
		current, next = next, current
	}
	for depth, matched := range current {
		if matched && depth > commonRootDepth {
			return true
		}
	}
	return false
}
