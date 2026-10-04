package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/not-stbenjam/arbor/internal/engine"
)

var version = "dev"

func main() {
	// Finder apps do not inherit interactive shell startup files.
	if runtime.GOOS == "darwin" {
		_ = os.Setenv("PATH", os.Getenv("PATH")+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
	}
	engine.Version = version
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	if err := execute(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			fmt.Fprintln(os.Stderr, "arbor: interrupted")
			os.Exit(130)
		}
		fmt.Fprintln(os.Stderr, "arbor:", err)
		os.Exit(1)
	}
}

func execute(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	root := newRootCommand(stdout, stderr)
	root.SetArgs(args)
	return root.ExecuteContext(ctx)
}
