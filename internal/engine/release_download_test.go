package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type downloadResult struct {
	binary []byte
	err    error
}

func fixtureDownloads(t *testing.T, before func(*http.Request) error) (*provisioner, *atomic.Int32) {
	t.Helper()
	files := map[string][]byte{}
	var manifest []byte
	for _, arch := range []string{"arm64", "amd64"} {
		stem := "arbor_v1.2.3_linux_" + arch
		archive := makeArchive(t, archiveFile{name: stem + "/arbor", data: "linux/" + arch})
		files["/v1.2.3/"+stem+".tar.gz"] = archive
		manifest = append(manifest, []byte(fmt.Sprintf("%x  %s.tar.gz\n", sha256.Sum256(archive), stem))...)
	}
	files["/v1.2.3/arbor_v1.2.3_checksums.txt"] = manifest
	requests := &atomic.Int32{}
	p := &provisioner{releaseBase: "https://releases.invalid", client: &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
		requests.Add(1)
		if before != nil {
			if err := before(req); err != nil {
				return nil, err
			}
		}
		data, ok := files[req.URL.Path]
		if !ok {
			return nil, fmt.Errorf("unexpected fixture release URL %s", req.URL)
		}
		return &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(data)), Body: io.NopCloser(bytes.NewReader(data))}, nil
	})}}
	return p, requests
}

func startDownload(p *provisioner, ctx context.Context, arch string) <-chan downloadResult {
	result := make(chan downloadResult, 1)
	go func() { data, err := p.download(ctx, "v1.2.3", "linux", arch); result <- downloadResult{data, err} }()
	return result
}

func awaitDownload(t *testing.T, result <-chan downloadResult) downloadResult {
	t.Helper()
	select {
	case got := <-result:
		return got
	case <-time.After(3 * time.Second):
		t.Fatal("download remained blocked")
		return downloadResult{}
	}
}

type downloadWaitContext struct {
	context.Context
	ready chan struct{}
	once  sync.Once
}

func (c *downloadWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.ready) })
	return c.Context.Done()
}

func TestDownloadDifferentPlatformsProceedWhileSameKeyWaiterCanCancel(t *testing.T) {
	blocked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	p, requests := fixtureDownloads(t, func(req *http.Request) error {
		if strings.HasSuffix(req.URL.Path, "_arm64.tar.gz") {
			close(blocked)
			select {
			case <-release:
			case <-req.Context().Done():
				return req.Context().Err()
			}
		}
		return nil
	})
	leader := startDownload(p, context.Background(), "arm64")
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("fixture download did not start")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waitContext := &downloadWaitContext{Context: ctx, ready: make(chan struct{})}
	waiter := startDownload(p, waitContext, "arm64")
	select {
	case <-waitContext.ready:
	case <-time.After(3 * time.Second):
		t.Fatal("same-key caller blocked on mutex instead of cancellable wait")
	}
	cancel()
	if got := awaitDownload(t, waiter); !errors.Is(got.err, context.Canceled) {
		t.Fatalf("waiter cancellation lost: %v", got.err)
	}
	other := awaitDownload(t, startDownload(p, context.Background(), "amd64"))
	if other.err != nil || string(other.binary) != "linux/amd64" {
		t.Fatalf("other architecture blocked or failed: %+v", other)
	}
	select {
	case <-leader:
		t.Fatal("canceling a waiter canceled the leader")
	default:
	}
	once.Do(func() { close(release) })
	if got := awaitDownload(t, leader); got.err != nil || string(got.binary) != "linux/arm64" {
		t.Fatalf("leader failed: %+v", got)
	}
	if got := requests.Load(); got != 4 {
		t.Fatalf("same-key waiter started redundant requests: %d", got)
	}
}

func TestDownloadSameKeySharesOneVerifiedResult(t *testing.T) {
	blocked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	p, requests := fixtureDownloads(t, func(req *http.Request) error {
		if strings.HasSuffix(req.URL.Path, ".tar.gz") {
			close(blocked)
			<-release
		}
		return nil
	})
	results := []<-chan downloadResult{startDownload(p, context.Background(), "arm64")}
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("download did not start")
	}
	for i := 0; i < 8; i++ {
		ctx := &downloadWaitContext{Context: context.Background(), ready: make(chan struct{})}
		results = append(results, startDownload(p, ctx, "arm64"))
		select {
		case <-ctx.ready:
		case <-time.After(3 * time.Second):
			t.Fatal("waiter not attached")
		}
	}
	once.Do(func() { close(release) })
	for _, result := range results {
		if got := awaitDownload(t, result); got.err != nil || string(got.binary) != "linux/arm64" {
			t.Fatalf("shared result failed: %+v", got)
		}
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("same release fetched %d times instead of one manifest/archive pair", got)
	}
}

func TestDownloadCanceledLeaderDoesNotCancelInterestedWaiter(t *testing.T) {
	blocked := make(chan struct{})
	var archives atomic.Int32
	p, requests := fixtureDownloads(t, func(req *http.Request) error {
		if strings.HasSuffix(req.URL.Path, ".tar.gz") && archives.Add(1) == 1 {
			close(blocked)
			<-req.Context().Done()
			return req.Context().Err()
		}
		return nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	leader := startDownload(p, ctx, "arm64")
	select {
	case <-blocked:
	case <-time.After(3 * time.Second):
		t.Fatal("leader did not start")
	}
	waitContext := &downloadWaitContext{Context: context.Background(), ready: make(chan struct{})}
	waiter := startDownload(p, waitContext, "arm64")
	select {
	case <-waitContext.ready:
	case <-time.After(3 * time.Second):
		t.Fatal("waiter not attached")
	}
	cancel()
	if got := awaitDownload(t, leader); !errors.Is(got.err, context.Canceled) {
		t.Fatalf("leader should cancel: %v", got.err)
	}
	if got := awaitDownload(t, waiter); got.err != nil || string(got.binary) != "linux/arm64" {
		t.Fatalf("interested waiter inherited another caller's cancellation: %+v", got)
	}
	if got := requests.Load(); got != 4 {
		t.Fatalf("expected one canceled attempt and one successful retry, got %d requests", got)
	}
	canceled, stop := context.WithCancel(context.Background())
	stop()
	if _, err := p.download(canceled, "v1.2.3", "linux", "arm64"); !errors.Is(err, context.Canceled) {
		t.Fatalf("already-canceled caller got cached success: %v", err)
	}
	if requests.Load() != 4 {
		t.Fatal("canceled caller performed network I/O")
	}
}
