package worktree

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Avoid inherited repository selectors when Arbor is run from a Git hook or alias.
func commandEnv() []string {
	var env []string
	for _, value := range os.Environ() {
		key := strings.SplitN(value, "=", 2)[0]
		if strings.HasPrefix(key, "GIT_") || key == "GH_HOST" || key == "GH_REPO" {
			continue
		}
		env = append(env, value)
	}
	return append(env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C", "GH_PROMPT_DISABLED=1")
}

func run(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	return runWith(ctx, timeout, nil, name, args...)
}

// runWith also sets the given variables, after the inherited ones are cleared.
func runWith(ctx context.Context, timeout time.Duration, env []string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = 2 * time.Second
	cmd.Env = append(commandEnv(), env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			return "", fmt.Errorf("%s: %w", name, err)
		}
		return "", fmt.Errorf("%s: %s", name, message)
	}
	return string(data), nil
}

func git(ctx context.Context, path string, args ...string) (string, error) {
	// Disable fsmonitor hooks, pagers, and external diff commands during inspection.
	// Output is parsed, so signature verification text must never precede it.
	prefix := []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "log.showSignature=false", "-C", path}
	return run(ctx, 30*time.Second, "git", append(prefix, args...)...)
}

func gitText(ctx context.Context, path string, args ...string) string {
	out, _ := git(ctx, path, args...)
	return strings.TrimSpace(out)
}

// Resolve metadata paths in one Git process. Repeated --git-path options keep
// Git's shared/per-worktree routing rules authoritative. Rare newline-containing
// paths use the unambiguous one-at-a-time fallback.
func gitPaths(ctx context.Context, path string, names []string) ([]string, error) {
	args := []string{"rev-parse", "--path-format=absolute"}
	for _, name := range names {
		args = append(args, "--git-path", name)
	}
	out, err := git(ctx, path, args...)
	if err != nil {
		return nil, err
	}
	paths := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(paths) == len(names) {
		return paths, nil
	}
	paths = nil
	for _, name := range names {
		out, err := git(ctx, path, "rev-parse", "--path-format=absolute", "--git-path", name)
		if err != nil {
			return nil, err
		}
		paths = append(paths, strings.TrimSuffix(out, "\n"))
	}
	return paths, nil
}

func parseList(raw string) []Worktree {
	var result []Worktree
	var w Worktree
	for _, line := range strings.Split(raw, "\x00") {
		if line == "" {
			if w.Path != "" {
				result = append(result, w)
				w = Worktree{}
			}
			continue
		}
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			w.Path = value
		case "HEAD":
			w.Head = value
		case "branch":
			w.Branch = strings.TrimPrefix(value, "refs/heads/")
		case "bare":
			w.Bare = true
		case "detached":
			w.Detached = true
		case "locked":
			w.Locked = true
			w.LockReason = value
		case "prunable":
			w.Missing = true
		}
	}
	if w.Path != "" {
		result = append(result, w)
	}
	return result
}
