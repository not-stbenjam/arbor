GO ?= go
VERSION ?= dev
PREFIX ?= $(HOME)/.local

.PHONY: build run desktop desktop-package test check package install

build:
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/arbor ./cmd/arbor

run:
	npm start

desktop:
	npm run desktop:dir

desktop-package:
	@if [ "$(VERSION)" = dev ]; then npm run desktop:package; else ARBOR_VERSION="$(VERSION)" npm run desktop:package; fi

test:
	$(GO) test -race ./...

check:
	$(GO) vet ./...
	$(GO) test -race ./...

package:
	GO="$(GO)" bash scripts/package.sh "$(VERSION)"

install: build
	install -d "$(PREFIX)/bin"
	install -m 755 bin/arbor "$(PREFIX)/bin/arbor"
