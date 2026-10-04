// Package stats keeps local, aggregate cleanup statistics without checkout paths.
package stats

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type Removal struct {
	SizeBytes int64
	Missing   bool
	Detached  bool
}

type Batch struct {
	ID        string
	SessionID string
	Removals  []Removal
}

type Day struct {
	Date                    string `json:"date"`
	RemovedWorktrees        int64  `json:"removedWorktrees"`
	EstimatedBytesReclaimed int64  `json:"estimatedBytesReclaimed"`
}

type Report struct {
	Version                 int    `json:"version"`
	RemovedWorktrees        int64  `json:"removedWorktrees"`
	EstimatedBytesReclaimed int64  `json:"estimatedBytesReclaimed"`
	MissingRegistrations    int64  `json:"missingRegistrations"`
	CleanupSessions         int64  `json:"cleanupSessions"`
	LargestWorktreeBytes    int64  `json:"largestWorktreeBytes"`
	DetachedCommitsRetained int64  `json:"detachedCommitsRetained"`
	FirstCleanupAt          string `json:"firstCleanupAt,omitempty"`
	LastCleanupAt           string `json:"lastCleanupAt,omitempty"`
	Daily                   []Day  `json:"daily"`
	Warning                 string `json:"warning,omitempty"`
}

type diskState struct {
	Report
	RecentBatchIDs   []string `json:"recentBatchIds,omitempty"`
	RecentSessionIDs []string `json:"recentSessionIds,omitempty"`
}

var errCorrupt = errors.New("invalid statistics file")

func location() (string, error) {
	if override := os.Getenv("ARBOR_STATS_PATH"); override != "" {
		return filepath.Abs(override)
	}
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "arbor", "statistics.json"), nil
}

func empty() diskState { return diskState{Report: Report{Version: 1, Daily: []Day{}}} }

// Load is read-only: displaying help or statistics never creates directories,
// locks, or settings. Atomic replacement by writers makes concurrent reads safe.
func Load() (Report, error) {
	file, err := location()
	if err != nil {
		return Report{}, err
	}
	state, err := read(file)
	if errors.Is(err, errCorrupt) {
		state = empty()
		state.Warning = "Previous statistics could not be read. The original file is untouched; a recoverable backup will be kept before recording new totals."
		return state.Report, nil
	}
	return state.Report, err
}

func read(file string) (diskState, error) {
	input, err := os.Open(file)
	if errors.Is(err, os.ErrNotExist) {
		return empty(), nil
	}
	if err != nil {
		return empty(), err
	}
	defer input.Close()
	data, err := io.ReadAll(io.LimitReader(input, 1024*1024+1))
	if err != nil {
		return empty(), err
	}
	var state diskState
	if len(data) > 1024*1024 || json.Unmarshal(data, &state) != nil {
		return empty(), errCorrupt
	}
	if state.Version > 1 {
		return empty(), fmt.Errorf("statistics were written by a newer Arbor version; existing totals were left untouched")
	}
	if !valid(state) {
		return empty(), errCorrupt
	}
	if state.Daily == nil {
		state.Daily = []Day{}
	}
	return state, nil
}

func valid(state diskState) bool {
	if state.Version != 1 || len(state.Daily) > 90 || len(state.RecentBatchIDs) > 128 || len(state.RecentSessionIDs) > 128 || len(state.Warning) > 512 {
		return false
	}
	for _, count := range []int64{state.RemovedWorktrees, state.EstimatedBytesReclaimed, state.MissingRegistrations, state.CleanupSessions, state.LargestWorktreeBytes, state.DetachedCommitsRetained} {
		if count < 0 {
			return false
		}
	}
	if state.MissingRegistrations > state.RemovedWorktrees || state.DetachedCommitsRetained > state.RemovedWorktrees || state.CleanupSessions > state.RemovedWorktrees {
		return false
	}
	for _, stamp := range []string{state.FirstCleanupAt, state.LastCleanupAt} {
		if stamp != "" {
			if _, err := time.Parse(time.RFC3339, stamp); err != nil {
				return false
			}
		}
	}
	previous := ""
	for _, day := range state.Daily {
		if _, err := time.Parse(time.DateOnly, day.Date); err != nil || day.Date <= previous || day.RemovedWorktrees < 0 || day.EstimatedBytesReclaimed < 0 {
			return false
		}
		previous = day.Date
	}
	for _, ids := range [][]string{state.RecentBatchIDs, state.RecentSessionIDs} {
		for _, id := range ids {
			if !validID(id) {
				return false
			}
		}
	}
	return true
}

func validID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// RecordRemovalBatch accepts confirmed successful removals only. It is separate
// from deletion: callers warn on errors without changing a successful outcome.
func RecordRemovalBatch(batch Batch) error {
	return record(batch, time.Now().UTC())
}

func record(batch Batch, now time.Time) error {
	if len(batch.Removals) == 0 {
		return nil
	}
	if batch.SessionID == "" {
		batch.SessionID = batch.ID
	}
	if !validID(batch.ID) || !validID(batch.SessionID) {
		return errors.New("invalid statistics batch or session identifier")
	}
	file, err := location()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(file+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("statistics are busy; timed out waiting to save totals")
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	state, err := read(file)
	if errors.Is(err, errCorrupt) {
		var suffix [8]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return err
		}
		backup := file + ".corrupt-" + now.Format("20060102T150405Z") + "-" + hex.EncodeToString(suffix[:])
		if err := os.Rename(file, backup); err != nil {
			return fmt.Errorf("preserve unreadable statistics before saving: %w", err)
		}
		state = empty()
		state.Warning = "Previous unreadable statistics were preserved in " + filepath.Base(backup) + "; new totals start here."
	} else if err != nil {
		return err
	}
	if contains(state.RecentBatchIDs, batch.ID) {
		return nil
	}
	if !contains(state.RecentSessionIDs, batch.SessionID) {
		state.CleanupSessions = add(state.CleanupSessions, 1)
		state.RecentSessionIDs = remember(state.RecentSessionIDs, batch.SessionID)
	}
	state.RecentBatchIDs = remember(state.RecentBatchIDs, batch.ID)
	var bytes int64
	for _, removal := range batch.Removals {
		state.RemovedWorktrees = add(state.RemovedWorktrees, 1)
		if removal.Missing {
			state.MissingRegistrations = add(state.MissingRegistrations, 1)
		} else if removal.SizeBytes > 0 {
			bytes = add(bytes, removal.SizeBytes)
			state.LargestWorktreeBytes = max(state.LargestWorktreeBytes, removal.SizeBytes)
		}
		if removal.Detached {
			state.DetachedCommitsRetained = add(state.DetachedCommitsRetained, 1)
		}
	}
	state.EstimatedBytesReclaimed = add(state.EstimatedBytesReclaimed, bytes)
	stamp := now.UTC().Format(time.RFC3339)
	if state.FirstCleanupAt == "" {
		state.FirstCleanupAt = stamp
	}
	state.LastCleanupAt = stamp
	cutoff, today := now.UTC().AddDate(0, 0, -89).Format(time.DateOnly), now.UTC().Format(time.DateOnly)
	days := make([]Day, 0, 90)
	for _, day := range state.Daily {
		if day.Date >= cutoff && day.Date <= today {
			days = append(days, day)
		}
	}
	if len(days) == 0 || days[len(days)-1].Date != today {
		days = append(days, Day{Date: today})
	}
	day := &days[len(days)-1]
	day.RemovedWorktrees = add(day.RemovedWorktrees, int64(len(batch.Removals)))
	day.EstimatedBytesReclaimed = add(day.EstimatedBytesReclaimed, bytes)
	state.Daily = days
	return save(file, state)
}

func contains(values []string, value string) bool {
	for _, existing := range values {
		if existing == value {
			return true
		}
	}
	return false
}

func remember(values []string, value string) []string {
	values = append(values, value)
	if len(values) > 128 {
		values = values[len(values)-128:]
	}
	return values
}

func add(a, b int64) int64 {
	if b > math.MaxInt64-a {
		return math.MaxInt64
	}
	return a + b
}

func save(file string, state diskState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(file), ".statistics-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = io.Copy(temporary, strings.NewReader(string(data)+"\n")); err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, file)
}
