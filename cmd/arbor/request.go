package main

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/stbenjam/arbor/internal/engine"
	"github.com/stbenjam/arbor/internal/worktree"
)

var cleanupSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// worktreeRequest is validated command intent, independent of Cobra and output.
type worktreeRequest struct {
	notActiveSince                          time.Time
	command, host                           string
	scan                                    worktree.Options
	preview, all, recommended, discardLocal bool
	// acknowledged names the grave losses that have been agreed to: all of
	// them with --force, otherwise the ones an integration showed its user.
	acknowledged                              []string
	expectMissing, expectEmpty, expectBranch  bool
	head, id, branch, sessionID               string
	watchStdin, json, progress, humanProgress bool
}

func normalizeRequest(command string, flags *commandOptions) (worktreeRequest, error) {
	r := worktreeRequest{command: command, host: flags.common.host, scan: flags.common.options(), preview: !flags.yes,
		all: flags.all, recommended: flags.recommended, discardLocal: flags.discardLocal || flags.force,
		expectMissing: flags.expectMissing, expectEmpty: flags.expectEmpty, expectBranch: flags.expectBranch,
		head: flags.head, id: flags.id, branch: flags.branch,
		sessionID: flags.statsSession, watchStdin: flags.watchStdin, json: flags.common.json,
		progress: flags.progress, humanProgress: !flags.common.json && !flags.quiet && !flags.progress}
	if command != "list" && command != "clean" && command != "remove" {
		return r, fmt.Errorf("unknown worktree command %q", command)
	}
	if flags.olderThan > 0 {
		r.notActiveSince = time.Now().Add(-time.Duration(flags.olderThan))
	}
	if flags.notActiveSince != "" {
		cutoff, err := time.Parse(time.RFC3339Nano, flags.notActiveSince)
		if err != nil || cutoff.IsZero() {
			return r, errors.New("--not-active-since needs a nonzero RFC 3339 timestamp")
		}
		r.notActiveSince = cutoff
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
	// --force is a person agreeing to everything the preview listed. An
	// integration passes --discard-local and names what it showed instead.
	if flags.force {
		r.acknowledged = worktree.GraveLosses()
	} else {
		for _, loss := range flags.acknowledge {
			if !slices.Contains(worktree.GraveLosses(), loss) {
				return r, fmt.Errorf("--acknowledge accepts %s, not %q", strings.Join(worktree.GraveLosses(), ", "), loss)
			}
		}
		if len(flags.acknowledge) > 0 && !r.discardLocal {
			return r, errors.New("--acknowledge applies to --discard-local")
		}
		r.acknowledged = flags.acknowledge
	}
	if r.expectMissing && r.expectEmpty {
		return r, errors.New("--expect-missing and --expect-empty are mutually exclusive")
	}
	if command == "clean" && flags.force && !r.all {
		return r, errors.New("--force applies to --all; without it, clean removes only clean, merged worktrees")
	}
	if r.sessionID != "" && !cleanupSessionPattern.MatchString(r.sessionID) {
		return r, errors.New("--stats-session must contain 1–128 letters, digits, hyphens, or underscores")
	}
	if err := engine.ValidateHost(r.host); err != nil {
		return r, err
	}
	// Consent to run is not consent to discard: only --force (or the
	// desktop's --discard-local) permits losing local files.
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
