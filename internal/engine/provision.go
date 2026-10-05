package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/stbenjam/arbor/internal/worktree"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var releaseVersion = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$`)

type provisioner struct {
	mu          sync.Mutex
	binaries    map[string][]byte
	inflight    map[string]*releaseDownload
	client      *http.Client
	releaseBase string
	run         sshRunner
	stream      func(context.Context, string, string, io.Reader, func(worktree.Progress)) ([]byte, error)
}

var managed = &provisioner{
	client:      defaultReleaseClient(),
	releaseBase: "https://github.com/stbenjam/arbor/releases/download",
	run:         runSSH,
	stream:      runSSHProgress,
}

func platform(uname string) (string, string, error) {
	parts := strings.Fields(uname)
	if len(parts) != 2 {
		return "", "", errors.New("could not identify remote system; expected uname system and architecture")
	}
	var system, architecture string
	switch parts[0] {
	case "Linux":
		system = "linux"
	case "Darwin":
		system = "darwin"
	default:
		return "", "", fmt.Errorf("unsupported remote operating system %q; Arbor supports Linux and macOS", parts[0])
	}
	switch parts[1] {
	case "x86_64", "amd64":
		architecture = "amd64"
	case "aarch64", "arm64":
		architecture = "arm64"
	default:
		return "", "", fmt.Errorf("unsupported remote architecture %q; Arbor supports x86-64 and ARM64", parts[1])
	}
	return system, architecture, nil
}

func managedBinary(version, system, architecture string) string {
	return `"$HOME"/` + quote(".cache/arbor/bin/"+version+"/"+system+"_"+architecture+"/arbor")
}

func (p *provisioner) command(ctx context.Context, timeout time.Duration, host, command string, input io.Reader) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return p.run(ctx, host, command, input)
}

func (p *provisioner) prepare(ctx context.Context, host, version string) (string, error) {
	if err := ValidateHost(host); err != nil {
		return "", err
	}
	if !releaseVersion.MatchString(version) {
		return "", fmt.Errorf("automatic SSH setup needs a released Arbor build (current version %q); download a release from https://github.com/stbenjam/arbor/releases", version)
	}
	// Probe on every operation: a host alias may now point to a different machine.
	info, err := p.command(ctx, 30*time.Second, host, "uname -s && uname -m", nil)
	if err != nil {
		return "", err
	}
	system, architecture, err := platform(string(info))
	if err != nil {
		return "", err
	}
	binary := managedBinary(version, system, architecture)
	probe := "if [ ! -L " + binary + " ] && [ -x " + binary + " ]; then " + binary + " --version; fi"
	current, err := p.command(ctx, 30*time.Second, host, probe, nil)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(current)) == "arbor "+version {
		return binary, nil
	}
	data, err := p.download(ctx, version, system, architecture)
	if err != nil {
		return "", fmt.Errorf("prepare Arbor for %s/%s on %s: %w", system, architecture, host, err)
	}
	install := installScript(version, system, architecture, len(data))
	if _, err := p.command(ctx, 2*time.Minute, host, install, bytes.NewReader(data)); err != nil {
		// Another Arbor window may have installed the same version after our
		// probe. Accept that result only after checking the executable again.
		current, probeErr := p.command(ctx, 30*time.Second, host, probe, nil)
		if probeErr == nil && strings.TrimSpace(string(current)) == "arbor "+version {
			return binary, nil
		}
		return "", fmt.Errorf("install managed Arbor: %w", err)
	}
	installed, err := p.command(ctx, 30*time.Second, host, probe, nil)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(installed)) != "arbor "+version {
		return "", errors.New("remote Arbor did not report the expected version after installation")
	}
	return binary, nil
}

// installScript receives the executable on standard input and publishes it at
// the managed path only once it is complete and runs. A transfer that ends
// early also ends its input, which cat cannot tell from success; a truncated
// file moved into place would then block every later attempt.
func installScript(version, system, architecture string, size int) string {
	directory := `"$HOME"/` + quote(".cache/arbor/bin/"+version+"/"+system+"_"+architecture)
	// mktemp and mv operate in the same directory. mv -n refuses to replace
	// anything another process (or the user) placed at the managed destination.
	return "set -eu; dir=" + directory + `; mkdir -p "$dir"; ` +
		`if [ -e "$dir/arbor" ] || [ -L "$dir/arbor" ]; then printf '%s\n' "Arbor's cache already holds a different file at $dir/arbor; move it aside and try again" >&2; exit 1; fi; ` +
		`tmp=$(mktemp "$dir/.arbor.XXXXXX"); trap 'rm -f "$tmp"' EXIT HUP INT TERM; ` +
		`cat > "$tmp"; ` +
		`if [ "$(wc -c < "$tmp" | tr -d '[:space:]')" != ` + strconv.Itoa(size) + ` ]; then printf '%s\n' 'The Arbor transfer was incomplete; try again' >&2; exit 1; fi; ` +
		`chmod 700 "$tmp"; ` +
		`if [ "$("$tmp" --version 2>/dev/null || true)" != ` + quote("arbor "+version) + ` ]; then printf '%s\n' 'The transferred Arbor does not run on this host' >&2; exit 1; fi; ` +
		`mv -n "$tmp" "$dir/arbor"`
}
