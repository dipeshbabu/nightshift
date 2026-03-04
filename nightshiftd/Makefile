.PHONY: proto build test clean lint debug

proto:
	buf generate

debug:
	go build -gcflags="all=-N -l" -o nightshiftd ./cmd/nightshiftd

build:
	go build -o nightshiftd ./cmd/nightshiftd

test:
	go test ./...

clean:
	rm -f nightshiftd

lint:
	go vet ./...
