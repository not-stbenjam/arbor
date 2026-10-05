package engine

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	maxBinaryBytes   = 128 * 1024 * 1024
	maxExpandedBytes = 192 * 1024 * 1024
)

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
	// The tar reader stops at the archive's end marker. Read on to the end of
	// the compressed stream, where gzip verifies its length and checksum.
	if _, err := io.Copy(io.Discard, bounded); err != nil {
		return nil, fmt.Errorf("read release archive: %w", err)
	}
	if bounded.N <= 0 {
		return nil, errors.New("expanded release archive exceeds size limit")
	}
	if len(binary) == 0 {
		return nil, errors.New("release archive does not contain the expected Arbor executable")
	}
	return binary, nil
}
