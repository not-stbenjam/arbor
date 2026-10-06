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
func Files(ctx context.Context, host, path, repository string, limit int) (worktree.FilesReport, error) {
	if err := ValidateHost(host); err != nil {
		return worktree.FilesReport{}, err
	}
	if host == "" {
		return worktree.Files(ctx, path, repository, limit)
	}
	args := []string{"files", "--json", "--watch-stdin", "--limit", strconv.Itoa(limit)}
	if repository != "" {
		args = append(args, "--repo", repository)
	}
	args = append(args, "--", path)
	data, err := ssh(ctx, host, args...)
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
