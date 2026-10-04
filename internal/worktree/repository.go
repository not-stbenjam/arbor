package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// repositoryMarkers cheaply narrows Git probes to actual candidate directories.
// It does not establish a repository: ordinary files can share these names.
func repositoryMarkers(directory string, entries []os.DirEntry) (marker, head, objects bool) {
	for _, entry := range entries {
		switch entry.Name() {
		case ".git":
			marker = true
		case "HEAD":
			head = true
		case "objects":
			objects = entry.IsDir()
			if entry.Type()&os.ModeSymlink != 0 {
				info, err := os.Stat(filepath.Join(directory, "objects"))
				objects = err == nil && info.IsDir()
			}
		}
	}
	return
}

// confirmedBareRepository is shared by discovery and deletion inspection. Git
// must recognize this exact directory, not an enclosing repository; misleading
// HEAD/objects names are neither a discovery boundary nor a removal blocker.
func confirmedBareRepository(ctx context.Context, directory string, entries []os.DirEntry) bool {
	_, head, objects := repositoryMarkers(directory, entries)
	if !head || !objects {
		return false
	}
	output, err := git(ctx, directory, "rev-parse", "--is-bare-repository", "--absolute-git-dir")
	if err != nil {
		return false
	}
	// Remove Git's terminator only; whitespace can be part of the directory.
	output = strings.TrimSuffix(output, "\n")
	bare, gitDir, ok := strings.Cut(output, "\n")
	if !ok || bare != "true" {
		return false
	}
	canonical, err := filepath.EvalSymlinks(gitDir)
	return err == nil && canonical == directory
}
