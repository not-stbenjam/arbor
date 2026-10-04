package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const (
	maxManifestBytes = 1024 * 1024
	maxArchiveBytes  = 100 * 1024 * 1024
)

func defaultReleaseClient() *http.Client {
	return &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return errors.New("release download redirected away from HTTPS")
		}
		if len(via) >= 10 {
			return errors.New("too many release download redirects")
		}
		return nil
	}}
}

type releaseDownload struct {
	done   chan struct{}
	binary []byte
	err    error
}

// download deduplicates only the same release/platform. Network and archive
// work never hold the shared mutex; waiting callers can cancel independently.
func (p *provisioner) download(ctx context.Context, version, system, architecture string) ([]byte, error) {
	key := version + "/" + system + "/" + architecture
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		p.mu.Lock()
		if binary := p.binaries[key]; binary != nil {
			p.mu.Unlock()
			return binary, nil
		}
		pending := p.inflight[key]
		if pending == nil {
			pending = &releaseDownload{done: make(chan struct{})}
			if p.inflight == nil {
				p.inflight = make(map[string]*releaseDownload)
			}
			p.inflight[key] = pending
			p.mu.Unlock()
			binary, err := p.downloadRelease(ctx, version, system, architecture)
			if ctx.Err() != nil {
				binary = nil
				err = ctx.Err()
			}
			p.mu.Lock()
			if err == nil {
				if p.binaries == nil {
					p.binaries = make(map[string][]byte)
				}
				p.binaries[key] = binary
			}
			pending.binary, pending.err = binary, err
			delete(p.inflight, key)
			close(pending.done)
			p.mu.Unlock()
			return binary, err
		}
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-pending.done:
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			// Cancellation belongs to the initiating caller. A still-interested
			// waiter retries under its own context instead of inheriting that cancel.
			if errors.Is(pending.err, context.Canceled) || errors.Is(pending.err, context.DeadlineExceeded) {
				continue
			}
			return pending.binary, pending.err
		}
	}
}

func (p *provisioner) downloadRelease(ctx context.Context, version, system, architecture string) ([]byte, error) {
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
