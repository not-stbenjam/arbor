package worktree

import (
	"os"
	"path/filepath"
	"strings"
)

func ResolveRoot(root string) (string, error) {
	if root == "" || root == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = home
	}
	if strings.HasPrefix(root, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(home, root[2:])
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
