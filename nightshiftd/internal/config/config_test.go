package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultValues(t *testing.T) {
	cfg := Default()

	if cfg.Version != 1 {
		t.Fatalf("expected version 1, got %d", cfg.Version)
	}
	if cfg.Daemon.StateDir != "/var/lib/nightshift" {
		t.Fatalf("unexpected state_dir: %s", cfg.Daemon.StateDir)
	}
	if cfg.Pool.IdleTimeout.Duration != 5*time.Minute {
		t.Fatalf("unexpected idle_timeout: %v", cfg.Pool.IdleTimeout)
	}
	if cfg.Pool.DefaultMaxPerAgent != 3 {
		t.Fatalf("unexpected default_max_per_agent: %d", cfg.Pool.DefaultMaxPerAgent)
	}
	if cfg.Runtime.Default != "auto" {
		t.Fatalf("unexpected runtime default: %s", cfg.Runtime.Default)
	}
	if cfg.Log.Level != "info" {
		t.Fatalf("unexpected log level: %s", cfg.Log.Level)
	}
}

func TestLoadTOML(t *testing.T) {
	content := `
version = 1

[daemon]
state_dir = "/tmp/ns"
socket = "/tmp/ns.sock"

[pool]
idle_timeout = "10m"
default_max_per_agent = 5

[log]
level = "debug"
format = "json"
`
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if cfg.Daemon.StateDir != "/tmp/ns" {
		t.Fatalf("unexpected state_dir: %s", cfg.Daemon.StateDir)
	}
	if cfg.Daemon.Socket != "/tmp/ns.sock" {
		t.Fatalf("unexpected socket: %s", cfg.Daemon.Socket)
	}
	if cfg.Pool.IdleTimeout.Duration != 10*time.Minute {
		t.Fatalf("unexpected idle_timeout: %v", cfg.Pool.IdleTimeout)
	}
	if cfg.Pool.DefaultMaxPerAgent != 5 {
		t.Fatalf("unexpected default_max_per_agent: %d", cfg.Pool.DefaultMaxPerAgent)
	}
	if cfg.Log.Level != "debug" {
		t.Fatalf("unexpected log level: %s", cfg.Log.Level)
	}
	if cfg.Log.Format != "json" {
		t.Fatalf("unexpected log format: %s", cfg.Log.Format)
	}

	// Defaults should be preserved for unset fields
	if cfg.Containerd.Address != "/run/containerd/containerd.sock" {
		t.Fatalf("expected containerd default, got: %s", cfg.Containerd.Address)
	}
	if cfg.Images.Base != "nightshift/agent-runtime:latest" {
		t.Fatalf("expected images default, got: %s", cfg.Images.Base)
	}
}

func TestDurationUnmarshal(t *testing.T) {
	tests := []struct {
		input    string
		expected time.Duration
	}{
		{"5m", 5 * time.Minute},
		{"30s", 30 * time.Second},
		{"1h", time.Hour},
		{"2h30m", 2*time.Hour + 30*time.Minute},
	}

	for _, tt := range tests {
		var d Duration
		if err := d.UnmarshalText([]byte(tt.input)); err != nil {
			t.Errorf("UnmarshalText(%q) failed: %v", tt.input, err)
			continue
		}
		if d.Duration != tt.expected {
			t.Errorf("UnmarshalText(%q) = %v, want %v", tt.input, d.Duration, tt.expected)
		}
	}
}

func TestDurationUnmarshalInvalid(t *testing.T) {
	var d Duration
	if err := d.UnmarshalText([]byte("bogus")); err == nil {
		t.Fatal("expected error for invalid duration")
	}
}

func TestLoadMissingFile(t *testing.T) {
	_, err := Load("/nonexistent/config.toml")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}
