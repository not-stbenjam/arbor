package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/stbenjam/arbor/internal/worktree"
)

// Files asks the machine that owns the folder; local paths never interpret a
// remote checkout and the remote command receives arguments, not shell text.
func Files(ctx context.Context, host, path, repository string, limit int, progress ...func(worktree.Progress)) (worktree.FilesReport, error) {
	return FilesWithRules(ctx, host, path, repository, limit, nil, progress...)
}

func FilesWithRules(ctx context.Context, host, path, repository string, limit int, rules []string, progress ...func(worktree.Progress)) (worktree.FilesReport, error) {
	if err := ValidateHost(host); err != nil {
		return worktree.FilesReport{}, err
	}
	var callback func(worktree.Progress)
	if len(progress) > 0 {
		callback = progress[0]
	}
	if host == "" {
		return worktree.FilesWithRules(ctx, path, repository, limit, rules, callback)
	}
	args := []string{"files", "--json", "--watch-stdin", "--limit", strconv.Itoa(limit)}
	if callback != nil {
		args = append(args, "--progress")
	}
	if repository != "" {
		args = append(args, "--repo", repository)
	}
	args = safeIgnoredArguments(args, rules)
	args = append(args, "--", path)
	data, err := sshProgress(ctx, host, callback, args...)
	if err != nil {
		return worktree.FilesReport{}, err
	}
	var report worktree.FilesReport
	if err := json.Unmarshal(data, &report); err != nil {
		return report, fmt.Errorf("unexpected remote file inventory: %w", err)
	}
	if report.Path == "" || report.Entries == nil || report.Counts == nil || report.Bytes == nil {
		return report, errors.New("remote Arbor returned an incomplete file inventory")
	}
	return report, nil
}
