//go:build linux || darwin

package main

import (
	"io"
	"os"
	"strconv"
	"syscall"
	"unsafe"
)

// A pipe or redirected file is unbounded, even when COLUMNS is inherited.
func terminalWidth(out io.Writer) int {
	file, ok := out.(*os.File)
	if !ok {
		return 0
	}
	var size struct{ rows, columns, x, y uint16 }
	_, _, err := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&size)))
	if err != 0 {
		return 0
	}
	return preferredWidth(os.Getenv("COLUMNS"), int(size.columns))
}

func preferredWidth(columns string, measured int) int {
	if width, err := strconv.Atoi(columns); err == nil && width > 0 {
		return width
	}
	if measured > 0 {
		return measured
	}
	return 100
}
