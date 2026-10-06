package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/stbenjam/arbor/internal/worktree"
)

func Restore(ctx context.Context, host string, options worktree.RestoreOptions) (result worktree.RestoreResult, err error) {
	if host == "" {
		return worktree.Restore(ctx, options)
	}
	result.Path, result.Branch = options.Path, options.Branch
	defer func() {
		if err != nil {
			result.Error = err.Error()
		}
	}()
	if err = worktree.ValidateRestore(options); err != nil {
		return
	}
	args := []string{"restore", "--json", "--repo", options.CommonDir}
	if options.Branch != "" {
		args = append(args, "--branch", options.Branch)
	} else {
		args = append(args, "--detach", options.Detach)
	}
	if options.Head != "" {
		args = append(args, "--head", options.Head)
	}
	args = append(args, "--", options.Path)
	data, err := ssh(ctx, host, args...)
	var remote worktree.RestoreResult
	parsed := len(data) <= maxProgressLine && json.Unmarshal(data, &remote) == nil && remote.Path == options.Path
	if err != nil {
		var exited *sshExitError
		if errors.As(err, &exited) && exited.status > 0 && exited.status != sshTransportStatus && parsed && !remote.Restored && remote.Error != "" {
			return result, fmt.Errorf("%s: %s", host, remote.Error)
		}
		return result, err
	}
	if !parsed || !remote.Restored || remote.Head == "" || remote.Branch != options.Branch {
		return result, errors.New("remote did not confirm restore; inspect the destination before trying again")
	}
	return remote, nil
}
