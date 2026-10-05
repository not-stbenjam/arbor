package engine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlatform(t *testing.T) {
	for _, tc := range []struct{ input, system, arch string }{
		{"Linux\nx86_64\n", "linux", "amd64"}, {"Linux\naarch64\n", "linux", "arm64"},
		{"Darwin\narm64\n", "darwin", "arm64"}, {"Darwin\nx86_64\n", "darwin", "amd64"},
	} {
		t.Run(tc.system+tc.arch, func(t *testing.T) {
			system, arch, err := platform(tc.input)
			if err != nil || system != tc.system || arch != tc.arch {
				t.Fatalf("platform(%q) = %q/%q, %v", tc.input, system, arch, err)
			}
		})
	}
	for _, input := range []string{"", "Linux", "Windows\nx86_64", "Linux\narmv7l", "banner\nLinux\nx86_64"} {
		if _, _, err := platform(input); err == nil {
			t.Fatalf("unsupported platform accepted: %q", input)
		}
	}
}

func TestQuotePreservesShellMetacharacters(t *testing.T) {
	for _, value := range []string{"", "a folder", "single'quote", "$(printf substituted)", "`printf substituted`", "a; printf injected", "line\nbreak", "$HOME", "*"} {
		out, err := exec.Command("sh", "-c", "set -- "+quote(value)+`; printf '%s' "$1"`).Output()
		if err != nil || string(out) != value {
			t.Fatalf("quote(%q): got %q, %v", value, out, err)
		}
	}
	command := remoteCommand(managedBinary("v1.2.3", "linux", "arm64"), []string{"list", "--path", "~/branch's work; echo injected"})
	if !strings.Contains(command, `"$HOME"/'.cache/arbor/bin/v1.2.3/linux_arm64/arbor'`) || !strings.Contains(command, quote("~/branch's work; echo injected")) {
		t.Fatalf("remote command is not safely quoted: %s", command)
	}
}

func TestValidateHost(t *testing.T) {
	for _, host := range []string{"buildbox", "alice@build.example", "user@[2001:db8::1]", ""} {
		if err := ValidateHost(host); err != nil {
			t.Fatalf("valid host %q rejected: %v", host, err)
		}
	}
	for _, host := range []string{"-oProxyCommand=bad", "host;command", "user@host extra", "host\ncommand", "$(command)", strings.Repeat("a", 256)} {
		if ValidateHost(host) == nil {
			t.Fatalf("unsafe host %q accepted", host)
		}
	}
}

type archiveFile struct {
	name, data string
	kind       byte
}

func makeArchive(t *testing.T, files ...archiveFile) []byte {
	t.Helper()
	var result bytes.Buffer
	zipped := gzip.NewWriter(&result)
	archive := tar.NewWriter(zipped)
	for _, file := range files {
		kind := file.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		size := int64(len(file.data))
		if kind != tar.TypeReg {
			size = 0
		}
		if err := archive.WriteHeader(&tar.Header{Name: file.name, Typeflag: kind, Mode: 0755, Size: size, Linkname: "/unrelated/arbor"}); err != nil {
			t.Fatal(err)
		}
		if size > 0 {
			if _, err := archive.Write([]byte(file.data)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func TestExtractSelectsOnlyExpectedExecutable(t *testing.T) {
	member := "arbor_v1.2.3_linux_arm64/arbor"
	archive := makeArchive(t,
		archiveFile{name: "../../arbor", data: "wrong"},
		archiveFile{name: "arbor_v1.2.3_linux_amd64/arbor", data: "wrong architecture"},
		archiveFile{name: member, data: "right executable"},
	)
	got, err := extractBinary(archive, member)
	if err != nil || string(got) != "right executable" {
		t.Fatalf("got %q: %v", got, err)
	}
	for _, files := range [][]archiveFile{
		{{name: "arbor", data: "wrong location"}},
		{{name: member, kind: tar.TypeSymlink}},
		{{name: member, kind: tar.TypeLink}},
		{{name: member, data: "one"}, {name: member, data: "two"}},
		{{name: member, data: ""}},
	} {
		if _, err := extractBinary(makeArchive(t, files...), member); err == nil {
			t.Fatalf("invalid archive accepted: %+v", files)
		}
	}
	if _, err := extractBinary([]byte("not an archive"), member); err == nil {
		t.Fatal("non-gzip accepted")
	}
}

func TestChecksumManifest(t *testing.T) {
	name := "arbor_v1.2.3_linux_arm64.tar.gz"
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("archive")))
	for _, marker := range []string{"  ", " *"} {
		got, err := checksumFor([]byte(hash+marker+name+"\n"), name)
		if err != nil || fmt.Sprintf("%x", got) != hash {
			t.Fatalf("checksum: %x, %v", got, err)
		}
	}
	for _, manifest := range []string{"", hash + "  wrong.tar.gz", "invalid  " + name, "abc  " + name, hash + "  " + name + "\n" + hash + "  " + name} {
		if _, err := checksumFor([]byte(manifest), name); err == nil {
			t.Fatalf("invalid manifest accepted: %q", manifest)
		}
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func releaseClient(t *testing.T, requests *int, corrupt bool) *http.Client {
	t.Helper()
	return &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
		*requests++
		if req.URL.Host != "releases.invalid" {
			t.Fatalf("unexpected download host: %s", req.URL)
		}
		var data []byte
		if strings.HasSuffix(req.URL.Path, "checksums.txt") {
			for _, system := range []string{"linux", "darwin"} {
				for _, arch := range []string{"amd64", "arm64"} {
					stem := "arbor_v1.2.3_" + system + "_" + arch
					archive := makeArchive(t, archiveFile{name: stem + "/arbor", data: system + "/" + arch})
					data = append(data, []byte(fmt.Sprintf("%x  %s.tar.gz\n", sha256.Sum256(archive), stem))...)
				}
			}
		} else {
			name := strings.TrimPrefix(req.URL.Path, "/v1.2.3/")
			stem := strings.TrimSuffix(name, ".tar.gz")
			parts := strings.Split(stem, "_")
			if len(parts) != 4 {
				t.Fatalf("unexpected artifact: %s", req.URL)
			}
			data = makeArchive(t, archiveFile{name: stem + "/arbor", data: parts[2] + "/" + parts[3]})
			if corrupt {
				data = append(data, 'x')
			}
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data))}, nil
	})}
}

func TestDownloadVerifiesChecksumAndCachesByPlatform(t *testing.T) {
	requests := 0
	p := &provisioner{client: releaseClient(t, &requests, false), releaseBase: "https://releases.invalid"}
	for _, tc := range []struct{ system, arch string }{{"linux", "arm64"}, {"linux", "arm64"}, {"darwin", "amd64"}} {
		data, err := p.download(context.Background(), "v1.2.3", tc.system, tc.arch)
		if err != nil || string(data) != tc.system+"/"+tc.arch {
			t.Fatalf("download %s/%s: %q %v", tc.system, tc.arch, data, err)
		}
	}
	if requests != 4 {
		t.Fatalf("want four requests for two uncached platforms; got %d", requests)
	}
	p = &provisioner{client: releaseClient(t, &requests, true), releaseBase: "https://releases.invalid"}
	if _, err := p.download(context.Background(), "v1.2.3", "linux", "arm64"); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("corrupt download accepted: %v", err)
	}
	if len(p.binaries) != 0 {
		t.Fatal("corrupt binary was cached")
	}
}

func TestPrepareInstallsMatchingReleaseAndRechecksRemote(t *testing.T) {
	requests, probes, installs := 0, 0, 0
	installed := false
	p := &provisioner{client: releaseClient(t, &requests, false), releaseBase: "https://releases.invalid"}
	p.run = func(ctx context.Context, host, command string, input io.Reader) ([]byte, error) {
		if host != "user@remote" {
			t.Fatalf("unexpected host %s", host)
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("remote command has no timeout")
		}
		switch {
		case command == "uname -s && uname -m":
			probes++
			return []byte("Linux\naarch64\n"), nil
		case strings.Contains(command, "mktemp"):
			installs++
			data, err := io.ReadAll(input)
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != "linux/arm64" || !strings.Contains(command, "mv -n") || !strings.Contains(command, "chmod 700") {
				t.Fatalf("incorrect binary or install: %q %s", data, command)
			}
			installed = true
			return nil, nil
		case strings.Contains(command, "--version"):
			if !strings.Contains(command, "linux_arm64") {
				t.Fatalf("wrong remote binary: %s", command)
			}
			if installed {
				return []byte("arbor v1.2.3\n"), nil
			}
			return nil, nil
		default:
			t.Fatalf("unexpected SSH command: %s", command)
			return nil, nil
		}
	}
	for i := 0; i < 2; i++ {
		binary, err := p.prepare(context.Background(), "user@remote", "v1.2.3")
		if err != nil || binary != managedBinary("v1.2.3", "linux", "arm64") {
			t.Fatalf("prepare: %s %v", binary, err)
		}
	}
	if requests != 2 || installs != 1 || probes != 2 {
		t.Fatalf("warm cache must recheck remote without download/upload: requests=%d installs=%d probes=%d", requests, installs, probes)
	}
}

func TestPrepareRefusesDevelopmentBuildsAndTransportFailure(t *testing.T) {
	p := &provisioner{run: func(context.Context, string, string, io.Reader) ([]byte, error) {
		return nil, errors.New("unknown host key")
	}}
	for _, version := range []string{"dev", "", "1.2.3", "v1.2.3/../../file", "v1.2.3;command"} {
		if _, err := p.prepare(context.Background(), "host", version); err == nil || !strings.Contains(err.Error(), "released Arbor build") {
			t.Fatalf("invalid version %q: %v", version, err)
		}
	}
	if _, err := p.prepare(context.Background(), "host", "v1.2.3"); err == nil || !strings.Contains(err.Error(), "unknown host key") {
		t.Fatalf("SSH transport failure lost: %v", err)
	}
}

func TestConcurrentInstallationRequiresExactVersion(t *testing.T) {
	for _, actual := range []string{"arbor v1.2.3", "arbor v9.9.9"} {
		p := &provisioner{binaries: map[string][]byte{"v1.2.3/linux/arm64": []byte("cached executable")}}
		probes := 0
		p.run = func(_ context.Context, _, command string, _ io.Reader) ([]byte, error) {
			switch {
			case command == "uname -s && uname -m":
				return []byte("Linux\narm64\n"), nil
			case strings.Contains(command, "mktemp"):
				return nil, errors.New("destination already exists")
			case strings.Contains(command, "--version"):
				probes++
				if probes == 1 {
					return nil, nil
				}
				return []byte(actual), nil
			default:
				t.Fatalf("unexpected SSH command: %s", command)
				return nil, nil
			}
		}
		_, err := p.prepare(context.Background(), "host", "v1.2.3")
		if (err == nil) != (actual == "arbor v1.2.3") {
			t.Fatalf("concurrent installation %q: %v", actual, err)
		}
	}
}

func TestFetchRejectsHTTPFailuresAndOversizedResponses(t *testing.T) {
	for _, tc := range []struct {
		status int
		length int64
		body   string
	}{{404, 0, ""}, {200, 20, "small"}, {200, -1, "too many bytes"}} {
		p := &provisioner{client: &http.Client{Transport: roundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: tc.status, ContentLength: tc.length, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
		})}}
		if _, err := p.fetch(context.Background(), "https://releases.invalid", 5); err == nil {
			t.Fatalf("invalid response accepted: %+v", tc)
		}
	}
}

// The installer is a shell script that runs on someone else's machine. Run the
// real one here: a transfer that ends early must never become the managed
// executable, because a broken file at that path blocks every later attempt.
func TestInstallScriptPublishesOnlyACompleteWorkingExecutable(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("a POSIX shell is required to run the installer")
	}
	const version = "v1.2.3"
	executable := "#!/bin/sh\nprintf '%s\\n' 'arbor " + version + "'\n"
	install := func(t *testing.T, home, input string, size int) (string, error) {
		t.Helper()
		cmd := exec.Command("sh", "-c", installScript(version, "linux", "arm64", size))
		cmd.Env = append(os.Environ(), "HOME="+home)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	// A home folder with a space and a quote exercises the script's quoting.
	home := filepath.Join(t.TempDir(), "dev's home")
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(home, ".cache", "arbor", "bin", version, "linux_arm64")
	managed := filepath.Join(directory, "arbor")
	leftovers := func() []string {
		entries, _ := os.ReadDir(directory)
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		return names
	}
	for name, tc := range map[string]struct {
		input   string
		size    int
		message string
	}{
		"transfer cut short":          {executable[:12], len(executable), "incomplete"},
		"complete but will not run":   {strings.Repeat("x", 40), 40, "does not run"},
		"runs but is another version": {"#!/bin/sh\necho 'arbor v9.9.9'\n", len("#!/bin/sh\necho 'arbor v9.9.9'\n"), "does not run"},
	} {
		out, err := install(t, home, tc.input, tc.size)
		if err == nil || !strings.Contains(out, tc.message) {
			t.Fatalf("%s: accepted or unexplained: %v %q", name, err, out)
		}
		if names := leftovers(); len(names) != 0 {
			t.Fatalf("%s: left files behind, blocking a retry: %v", name, names)
		}
	}
	if out, err := install(t, home, executable, len(executable)); err != nil {
		t.Fatalf("complete transfer refused: %v %s", err, out)
	}
	data, err := os.ReadFile(managed)
	info, statErr := os.Stat(managed)
	if err != nil || statErr != nil || string(data) != executable || info.Mode().Perm() != 0700 {
		t.Fatalf("installed file differs: %q %v %v", data, err, statErr)
	}
	if names := leftovers(); len(names) != 1 {
		t.Fatalf("temporary files remain beside the executable: %v", names)
	}
	// Something already at the destination is never replaced, and the message
	// says where it is.
	out, err := install(t, home, executable, len(executable))
	if err == nil || !strings.Contains(out, managed) {
		t.Fatalf("an existing destination was replaced or not named: %v %q", err, out)
	}
}

// The checksum covers the archive file, but gzip's own length and checksum
// sit after the tar data and are only verified by reading to the end.
func TestExtractVerifiesTheCompressedStreamToItsEnd(t *testing.T) {
	archive := makeArchive(t, archiveFile{name: "arbor_v1.2.3_linux_arm64/arbor", data: "executable"})
	if binary, err := extractBinary(archive, "arbor_v1.2.3_linux_arm64/arbor"); err != nil || string(binary) != "executable" {
		t.Fatalf("valid archive: %q %v", binary, err)
	}
	corrupt := bytes.Clone(archive)
	corrupt[len(corrupt)-5] ^= 0xff // within the trailing CRC-32 and length
	if _, err := extractBinary(corrupt, "arbor_v1.2.3_linux_arm64/arbor"); err == nil {
		t.Fatal("an archive with a corrupt gzip trailer was accepted")
	}
	if _, err := extractBinary(archive[:len(archive)-4], "arbor_v1.2.3_linux_arm64/arbor"); err == nil {
		t.Fatal("a truncated archive was accepted")
	}
}
