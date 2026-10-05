package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func launchDesktop(options commonFlags) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	directory := filepath.Dir(executable)
	var candidates []string
	if runtime.GOOS == "darwin" {
		home, _ := os.UserHomeDir()
		candidates = []string{filepath.Join(directory, "Arbor"), filepath.Join(directory, "../../MacOS/Arbor"), filepath.Join(directory, "Arbor.app/Contents/MacOS/Arbor"), "/Applications/Arbor.app/Contents/MacOS/Arbor", filepath.Join(home, "Applications/Arbor.app/Contents/MacOS/Arbor")}
	} else {
		candidates = []string{filepath.Join(directory, "arbor-desktop"), filepath.Join(directory, "../../arbor-desktop")}
		if path, err := exec.LookPath("arbor-desktop"); err == nil {
			candidates = append(candidates, path)
		}
	}
	var args []string
	if options.root != "" {
		args = append(args, "--path", options.root)
	}
	if options.host != "" {
		args = append(args, "--host", options.host)
	}
	if options.github {
		args = append(args, "--github")
	}
	if options.fetch {
		args = append(args, "--fetch")
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() || info.Mode().Perm()&0111 == 0 {
			continue
		}
		cmd := exec.Command(candidate, args...)
		cmd.Env = append(os.Environ(), "ARBOR_CLI_PATH="+executable)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	}
	return fmt.Errorf("native Arbor app not found; install the desktop download from https://github.com/stbenjam/arbor/releases (CLI commands such as 'arbor list' work independently)")
}
