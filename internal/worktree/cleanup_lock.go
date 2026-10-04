package worktree

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// acquireCleanupLock owns an advisory lock for the returned file's lifetime.
// Never unlink this file: concurrent openers must lock the same persistent
// inode. The kernel releases ownership on normal close, exit, or SIGKILL.
func acquireCleanupLock(common string) (*os.File, error) {
	legacy := filepath.Join(common, "arbor-cleanup.lock")
	checkLegacy := func() error {
		if _, err := os.Lstat(legacy); err == nil {
			// Old Arbor closed its empty O_EXCL sentinel immediately; neither
			// file contents nor open descriptors can identify a live owner.
			return fmt.Errorf("legacy cleanup lock exists: close older Arbor processes, then move aside %s before retrying", legacy)
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("cannot inspect legacy cleanup lock: %w", err)
		}
		return nil
	}
	if err := checkLegacy(); err != nil {
		return nil, err
	}
	filename := filepath.Join(common, "arbor-cleanup.flock")
	fd, err := syscall.Open(filename, syscall.O_CREAT|syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, fmt.Errorf("cannot open cleanup lock: %w", err)
	}
	lock := os.NewFile(uintptr(fd), filename)
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() {
		lock.Close()
		return nil, fmt.Errorf("cleanup lock is not a readable regular file")
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("cannot acquire cleanup lock (another cleanup may be running): %w", err)
	}
	if err := checkLegacy(); err != nil {
		lock.Close()
		return nil, err
	}
	return lock, nil
}
