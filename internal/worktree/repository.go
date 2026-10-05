package worktree

import (
	"context"
	"fmt"
	"io"
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

type repositoryKind uint8

const (
	repositoryNone repositoryKind = iota
	repositoryBare
	repositoryMetadata
)

// recognizeRepository distinguishes ordinary lookalikes from exact Git metadata
// directories and from plausible metadata that could not safely be inspected.
func recognizeRepository(ctx context.Context, directory string, entries []os.DirEntry) (repositoryKind, error) {
	_, head, objects := repositoryMarkers(directory, entries)
	if !head || !objects {
		return repositoryNone, nil
	}
	// An explicit selector is required by safe.bareRepository=explicit. A
	// policy refusal of implicit discovery must not masquerade as a lookalike.
	output, err := git(ctx, directory, "--git-dir="+directory, "rev-parse", "--is-bare-repository", "--absolute-git-dir")
	if err != nil {
		if ctx.Err() != nil {
			return repositoryNone, ctx.Err()
		}
		plausible, shapeErr := plausibleGitDirectory(directory)
		if shapeErr != nil {
			return repositoryNone, shapeErr
		}
		if !plausible {
			return repositoryNone, nil
		}
		return repositoryNone, fmt.Errorf("cannot verify nested Git metadata at %s: %w", directory, err)
	}
	// Remove Git's terminator only; whitespace can be part of the directory.
	output = strings.TrimSuffix(output, "\n")
	bare, gitDir, ok := strings.Cut(output, "\n")
	if !ok || (bare != "true" && bare != "false") {
		return repositoryNone, fmt.Errorf("unexpected Git metadata response for %s", directory)
	}
	canonical, err := filepath.EvalSymlinks(gitDir)
	if err != nil {
		return repositoryNone, err
	}
	if canonical != directory {
		return repositoryNone, nil
	}
	if bare == "true" {
		return repositoryBare, nil
	}
	// With --git-dir Git stops inferring bare=true from a minimal HEAD/objects/
	// refs directory. Honor an explicit non-bare/worktree config, but retain
	// bare classification for these valid config-less scratch repositories.
	configured, err := git(ctx, directory, "--git-dir="+directory, "config", "--type=bool", "--default=true", "--get", "core.bare")
	if err != nil {
		return repositoryNone, err
	}
	if strings.TrimSpace(configured) == "false" {
		return repositoryMetadata, nil
	}
	worktree, err := git(ctx, directory, "--git-dir="+directory, "config", "--default=", "--get", "core.worktree")
	if err != nil {
		return repositoryNone, err
	}
	if strings.TrimSuffix(worktree, "\n") != "" {
		return repositoryMetadata, nil
	}
	return repositoryBare, nil
}

// Only failed Git probes need this distinction. Invalid ordinary HEAD files or
// missing refs are harmless lookalikes; a credible metadata tree whose Git
// config cannot be read is uncertainty, not permission to discard it.
func plausibleGitDirectory(directory string) (bool, error) {
	info, err := os.Stat(filepath.Join(directory, "HEAD"))
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, nil
	}
	head, err := os.Open(filepath.Join(directory, "HEAD"))
	if err != nil {
		return false, err
	}
	data, readErr := io.ReadAll(io.LimitReader(head, 1025))
	head.Close()
	if readErr != nil {
		return false, readErr
	}
	value := strings.TrimSpace(string(data))
	validHead := len(value) > 5 && strings.HasPrefix(value, "ref: ")
	if len(value) == 40 || len(value) == 64 {
		validHead = true
		for _, c := range value {
			if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
				validHead = false
				break
			}
		}
	}
	if len(data) > 1024 || !validHead {
		return false, nil
	}
	refs, err := os.Stat(filepath.Join(directory, "refs"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return refs.IsDir(), nil
}

// resolveCommonDirectory retains normal checkout discovery, but explicitly
// selects a verified bare candidate when Git disallows implicit bare discovery.
// The second result is an optional --git-dir selector for subsequent commands.
// When nothing is found, the error is Git's own reason, such as an ownership
// or safety policy that only the user can decide to change.
func resolveCommonDirectory(ctx context.Context, directory string) (common, explicitGitDir string, reason error) {
	output, reason := git(ctx, directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if reason == nil && strings.TrimSuffix(output, "\n") != directory {
		return strings.TrimSuffix(output, "\n"), "", nil
	}
	entries, err := os.ReadDir(directory)
	if err == nil {
		kind, probeErr := recognizeRepository(ctx, directory, entries)
		if probeErr == nil {
			if kind == repositoryBare {
				return directory, directory, nil
			}
			if kind == repositoryMetadata {
				return directory, "", nil
			}
		} else if reason == nil {
			reason = probeErr
		}
	}
	return "", "", reason
}

// Commands against an already verified common Git directory should identify it
// explicitly, including bare backing repositories with restrictive Git config.
func gitCommon(ctx context.Context, common string, args ...string) (string, error) {
	return git(ctx, common, append([]string{"--git-dir=" + common}, args...)...)
}

func gitCommonText(ctx context.Context, common string, args ...string) string {
	output, _ := gitCommon(ctx, common, args...)
	return strings.TrimSpace(output)
}
