package main

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/not-stbenjam/arbor/internal/engine"
	"github.com/not-stbenjam/arbor/internal/worktree"
)

var cleanupSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// worktreeRequest is validated command intent, independent of Cobra and output.
type worktreeRequest struct {
	command, host                             string
	scan                                      worktree.Options
	preview, all, recommended, discardLocal   bool
	expectMissing, expectEmpty                bool
	head, id, branch, sessionID               string
	watchStdin, json, progress, humanProgress bool
}

func normalizeRequest(command string, flags *commandOptions) (worktreeRequest, error) {
	r := worktreeRequest{command: command, host: flags.common.host, scan: flags.common.options(), preview: !flags.yes,
		all: flags.all, recommended: flags.recommended, discardLocal: flags.discardLocal || flags.force,
		expectMissing: flags.expectMissing, expectEmpty: flags.expectEmpty, head: flags.head, id: flags.id, branch: flags.branch,
		sessionID: flags.statsSession, watchStdin: flags.watchStdin, json: flags.common.json,
		progress: flags.progress, humanProgress: !flags.common.json && !flags.quiet && !flags.progress}
	if command != "list" && command != "clean" && command != "remove" {
		return r, fmt.Errorf("unknown worktree command %q", command)
	}
	policyFlag := "--discard-local"
	if flags.force {
		policyFlag = "--force"
	}
	if r.discardLocal && r.recommended {
		return r, fmt.Errorf("%s cannot be combined with --recommended-only", policyFlag)
	}
	if r.discardLocal && flags.keepLocal {
		return r, fmt.Errorf("%s and --keep-local are mutually exclusive", policyFlag)
	}
	if r.expectMissing && r.expectEmpty {
		return r, errors.New("--expect-missing and --expect-empty are mutually exclusive")
	}
	if r.sessionID != "" && !cleanupSessionPattern.MatchString(r.sessionID) {
		return r, errors.New("--stats-session must contain 1–128 letters, digits, hyphens, or underscores")
	}
	if err := engine.ValidateHost(r.host); err != nil {
		return r, err
	}
	r.discardLocal = r.discardLocal || command == "remove" && !r.recommended && !flags.keepLocal || command == "clean" && r.all
	r.scan.Repository = flags.repository
	r.scan.LinkedOnly = flags.linkedOnly
	r.scan.TargetOnly = command == "remove" || flags.targetOnly
	if flags.noDefaultExcludes || len(flags.excludes) > 0 {
		r.scan.Excludes = []string{}
		if !flags.noDefaultExcludes {
			r.scan.Excludes = append(r.scan.Excludes, worktree.DefaultExcludes()...)
		}
		r.scan.Excludes = append(r.scan.Excludes, flags.excludes...)
	}
	return r, nil
}

func (r worktreeRequest) recommendedRemoval() bool {
	return r.recommended || r.command == "clean" && !r.all
}
