package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestUsageErrorsHaveDistinctExitStatus(t *testing.T) {
	isolatedCommandEnvironment(t)
	for _, args := range [][]string{
		{"nonsense"}, {"list", "--unknown"}, {"list", "extra"}, {"remove"},
		{"remove", "one", "two"}, {"remove", "one", "--head="},
		{"list", "--json=bad"}, {"list", "--older-than=bad"}, {"list", "--sort=bad"}, {"list", "--sort="},
		{"clean", "--force"}, {"remove", "one", "--force", "--keep-local"},
		{"remove", "one", "--force", "--recommended-only"}, {"remove", "one", "--acknowledge=bad"},
		{"remove", "one", "--stats-session=bad value"}, {"list", "--host=-bad"},
		{"stats", "--host=-bad"}, {"gui", "--host=-bad"}, {"completion", "bash", "extra"},
		{"completion", "unknown"}, {"list", "--exclude=["}, {"clean", "--exclude="},
	} {
		out, _, err := commandOutput(t, args...)
		if exitStatus(err) != 2 || out != "" {
			t.Errorf("%v: status %d, %v, %s", args, exitStatus(err), err, out)
		}
	}
	for _, tc := range []struct {
		err  error
		want int
	}{{nil, 0}, {errors.New("scan failed"), 1}, {context.Canceled, 130}, {fmt.Errorf("wrapped: %w", &usageFailure{errors.New("usage")}), 2}} {
		if got := exitStatus(tc.err); got != tc.want {
			t.Errorf("%v: %d", tc.err, got)
		}
	}
}
