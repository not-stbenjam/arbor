package worktree

import (
	"os"
	"path/filepath"
	"strings"
)

func ResolveRoot(root string) (string, error) {
	abs, err := expandRoot(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// expandRoot is the folder as it was named, made absolute, before any
// symbolic link in it is followed.
func expandRoot(root string) (string, error) {
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
	return filepath.Abs(root)
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
