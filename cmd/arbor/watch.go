package main

import (
	"context"
	"os"
	"syscall"
)

// watchInput binds remote list's lifetime to the SSH channel. An owned,
// pollable duplicate lets cleanup interrupt the read without leaking a watcher.
func watchInput(ctx context.Context, input *os.File, cancel context.CancelFunc) func() {
	stopped := make(chan struct{})
	fd, err := syscall.Dup(int(input.Fd()))
	if err != nil {
		cancel()
		return func() {}
	}
	syscall.CloseOnExec(fd)
	if err := syscall.SetNonblock(fd, true); err != nil {
		_ = syscall.Close(fd)
		cancel()
		return func() {}
	}
	reader := os.NewFile(uintptr(fd), "arbor-ssh-lifetime")
	go func() {
		defer close(stopped)
		var buffer [256]byte
		for {
			_, err := reader.Read(buffer[:])
			if err != nil || ctx.Err() != nil {
				cancel()
				return
			}
		}
	}()
	return func() {
		_ = reader.Close()
		<-stopped
	}
}
