package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/stbenjam/arbor/internal/worktree"
)

// ageDuration adds fixed-length days and weeks to Go's duration syntax.
type ageDuration time.Duration

func (d *ageDuration) String() string { return time.Duration(*d).String() }
func (d *ageDuration) Type() string   { return "duration" }
func (d *ageDuration) Set(value string) error {
	text, multiplier := value, time.Duration(1)
	for suffix, hours := range map[string]time.Duration{"d": 24, "w": 168} {
		if strings.HasSuffix(value, suffix) {
			text, multiplier = strings.TrimSuffix(value, suffix)+"h", hours
			break
		}
	}
	parsed, err := time.ParseDuration(text)
	if err != nil || parsed <= 0 || parsed > time.Duration(1<<63-1)/multiplier {
		return fmt.Errorf("expected a positive duration such as 30d, 12h or 2w")
	}
	*d = ageDuration(parsed * multiplier)
	return nil
}

func matchesAge(w worktree.Worktree, cutoff time.Time) bool {
	return cutoff.IsZero() || !w.ActivityAt.IsZero() && !w.ActivityAt.After(cutoff)
}
