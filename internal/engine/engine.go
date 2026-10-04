// Package engine runs the same inspection and removal contract locally or over SSH.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

var hostPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.@:\[\]-]*$`)

// Version is set to the local release version by the executable entry point.
var Version = "dev"

func ValidateHost(host string) error {
	if host != "" && (!hostPattern.MatchString(host) || len(host) > 255) {
		return errors.New("use an SSH host alias or user@hostname (configure ports and keys in ~/.ssh/config)")
	}
	return nil
}

func quote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

func remoteCommand(binary string, args []string) string {
	var quoted []string
	for _, arg := range args {
		quoted = append(quoted, quote(arg))
	}
	arguments := strings.Join(quoted, " ")
	return "exec " + binary + " " + arguments
}

func ssh(ctx context.Context, host string, args ...string) ([]byte, error) {
	return sshProgress(ctx, host, nil, args...)
}

func sshProgress(ctx context.Context, host string, progress func(worktree.Progress), args ...string) ([]byte, error) {
	if err := ValidateHost(host); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	if progress != nil {
		progress(worktree.Progress{Stage: "connecting", Path: host})
	}
	binary, err := managed.prepare(ctx, host, Version)
	if err != nil {
		return nil, err
	}
	if progress != nil && managed.stream != nil {
		return managed.stream(ctx, host, remoteCommand(binary, args), nil, progress)
	}
	return managed.run(ctx, host, remoteCommand(binary, args), nil)
}

func Scan(ctx context.Context, host string, options worktree.Options) (worktree.Report, error) {
	if host == "" {
		return worktree.Scan(ctx, options)
	}
	root := options.Root
	if root == "" {
		root = "~"
	}
	args := []string{"list", "--json", "--watch-stdin", "--path", root}
	if options.TargetOnly {
		args = append(args, "--target-only")
	}
	if options.Repository != "" {
		args = append(args, "--repo", options.Repository)
	}
	args = append(args, "--linked-only="+strconv.FormatBool(options.LinkedOnly))
	if options.Excludes != nil {
		args = append(args, "--no-default-excludes")
		for _, exclude := range options.Excludes {
			args = append(args, "--exclude", exclude)
		}
	}
	if options.Progress != nil {
		args = append(args, "--progress")
	}
	if options.GitHub {
		args = append(args, "--github")
	}
	if options.Fetch {
		args = append(args, "--fetch")
	}
	data, err := sshProgress(ctx, host, options.Progress, args...)
	if err != nil {
		return worktree.Report{}, err
	}
	var report worktree.Report
	if err := json.Unmarshal(data, &report); err != nil {
		return report, fmt.Errorf("unexpected remote output; use the same Arbor version on both computers: %w", err)
	}
	if report.Root == "" || report.Worktrees == nil {
		return report, errors.New("remote Arbor returned an incomplete report")
	}
	return report, nil
}
