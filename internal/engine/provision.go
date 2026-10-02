package engine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

const (
	maxManifestBytes = 1024 * 1024
	maxArchiveBytes  = 100 * 1024 * 1024
	maxBinaryBytes   = 128 * 1024 * 1024
	maxExpandedBytes = 192 * 1024 * 1024
)

var releaseVersion = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$`)

type sshRunner func(context.Context, string, string, io.Reader) ([]byte, error)

type provisioner struct {
	mu          sync.Mutex
	binaries    map[string][]byte
	client      *http.Client
	releaseBase string
	run         sshRunner
	stream      func(context.Context, string, string, io.Reader, func(worktree.Progress)) ([]byte, error)
}

var managed = &provisioner{
	client: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return errors.New("release download redirected away from HTTPS")
		}
		if len(via) >= 10 {
			return errors.New("too many release download redirects")
		}
		return nil
	}},
	releaseBase: "https://github.com/not-stbenjam/arbor/releases/download",
	run:         runSSH,
	stream:      runSSHProgress,
}

func runSSH(ctx context.Context, host, command string, input io.Reader) ([]byte, error) {
	return runSSHProgress(ctx, host, command, input, nil)
}

func runSSHProgress(ctx context.Context, host, command string, input io.Reader, progress func(worktree.Progress)) ([]byte, error) {
	if err := ValidateHost(host); err != nil {
		return nil, err
	}
	if host == "" {
		return nil, errors.New("SSH host is required")
	}
	// Run the installer in a POSIX shell even when the user's login shell is fish.
	cmd := exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "--", host, "sh -c "+quote(command))
	cmd.WaitDelay = 2 * time.Second
	cmd.Stdin = input
	if input == nil {
		// An open stdin acts as a lifetime signal for remote list --watch-stdin.
		// Use *os.File rather than an io.Pipe so exec does not wait for an
		// input-copy goroutine after a normal, successful remote exit.
		reader, writer, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		defer writer.Close()
		cmd.Stdin = reader
	}
	stderr := &progressWriter{callback: progress}
	cmd.Stderr = stderr
	data, err := cmd.Output()
	stderr.flush()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		detail := strings.TrimSpace(stderr.diagnostics.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("SSH %s: %s. Check SSH keys, known_hosts, and the host configuration", host, detail)
	}
	return data, nil
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
		return "", fmt.Errorf("automatic SSH setup needs a released Arbor build (current version %q); download a release from https://github.com/not-stbenjam/arbor/releases", version)
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
	directory := `"$HOME"/` + quote(".cache/arbor/bin/"+version+"/"+system+"_"+architecture)
	// mktemp and mv operate in the same directory. mv -n refuses to replace
	// anything another process (or the user) placed at the managed destination.
	install := "set -eu; dir=" + directory + `; mkdir -p "$dir"; ` +
		`if [ -e "$dir/arbor" ] || [ -L "$dir/arbor" ]; then printf '%s\n' 'Arbor cache path already exists with a different version; move it aside before retrying' >&2; exit 1; fi; ` +
		`tmp=$(mktemp "$dir/.arbor.XXXXXX"); trap 'rm -f "$tmp"' EXIT HUP INT TERM; ` +
		`cat > "$tmp"; chmod 700 "$tmp"; mv -n "$tmp" "$dir/arbor"`
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

func (p *provisioner) download(ctx context.Context, version, system, architecture string) ([]byte, error) {
	key := version + "/" + system + "/" + architecture
	p.mu.Lock()
	defer p.mu.Unlock()
	if binary := p.binaries[key]; binary != nil {
		return binary, nil
	}
	stem := "arbor_" + version + "_" + system + "_" + architecture
	archiveName := stem + ".tar.gz"
	base := p.releaseBase + "/" + url.PathEscape(version) + "/"
	manifest, err := p.fetch(ctx, base+url.PathEscape("arbor_"+version+"_checksums.txt"), maxManifestBytes)
	if err != nil {
		return nil, err
	}
	expected, err := checksumFor(manifest, archiveName)
	if err != nil {
		return nil, err
	}
	archive, err := p.fetch(ctx, base+url.PathEscape(archiveName), maxArchiveBytes)
	if err != nil {
		return nil, err
	}
	actual := sha256.Sum256(archive)
	if !bytes.Equal(actual[:], expected) {
		return nil, fmt.Errorf("SHA-256 checksum does not match for %s", archiveName)
	}
	binary, err := extractBinary(archive, stem+"/arbor")
	if err != nil {
		return nil, err
	}
	if p.binaries == nil {
		p.binaries = make(map[string][]byte)
	}
	p.binaries[key] = binary
	return binary, nil
}

func (p *provisioner) fetch(ctx context.Context, address string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Arbor/"+Version)
	response, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download release: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release download returned HTTP %d; confirm this Arbor version has published release assets", response.StatusCode)
	}
	if response.ContentLength > limit {
		return nil, errors.New("release download exceeds size limit")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read release download: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, errors.New("release download exceeds size limit")
	}
	return data, nil
}

func checksumFor(manifest []byte, archiveName string) ([]byte, error) {
	var checksum []byte
	for _, line := range strings.Split(string(manifest), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || strings.TrimPrefix(fields[1], "*") != archiveName {
			continue
		}
		if checksum != nil {
			return nil, errors.New("duplicate archive in release checksum manifest")
		}
		decoded, err := hex.DecodeString(fields[0])
		if err != nil || len(decoded) != sha256.Size {
			return nil, errors.New("invalid release SHA-256 checksum")
		}
		checksum = decoded
	}
	if checksum == nil {
		return nil, fmt.Errorf("release checksum manifest does not contain %s", archiveName)
	}
	return checksum, nil
}

func extractBinary(archive []byte, member string) ([]byte, error) {
	zipped, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open release archive: %w", err)
	}
	defer zipped.Close()
	bounded := &io.LimitedReader{R: zipped, N: maxExpandedBytes + 1}
	reader := tar.NewReader(bounded)
	var binary []byte
	for {
		header, err := reader.Next()
		if bounded.N <= 0 {
			return nil, errors.New("expanded release archive exceeds size limit")
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read release archive: %w", err)
		}
		if header.Name != member {
			continue
		}
		if binary != nil || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > maxBinaryBytes {
			return nil, errors.New("release archive has an invalid Arbor executable")
		}
		binary, err = io.ReadAll(io.LimitReader(reader, maxBinaryBytes+1))
		if err != nil {
			return nil, fmt.Errorf("read Arbor executable: %w", err)
		}
		if int64(len(binary)) != header.Size {
			return nil, errors.New("release executable size does not match archive header")
		}
	}
	if len(binary) == 0 {
		return nil, errors.New("release archive does not contain the expected Arbor executable")
	}
	return binary, nil
}
