package config

import (
	"fmt"
	"os"
	"time"

	"github.com/BurntSushi/toml"
)

// Duration wraps time.Duration for TOML string unmarshaling (e.g. "5m").
type Duration struct {
	time.Duration
}

func (d *Duration) UnmarshalText(text []byte) error {
	var err error
	d.Duration, err = time.ParseDuration(string(text))
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", text, err)
	}
	return nil
}

type Config struct {
	Version    int              `toml:"version"`
	Daemon     DaemonConfig     `toml:"daemon"`
	Pool       PoolConfig       `toml:"pool"`
	Containerd ContainerdConfig `toml:"containerd"`
	Runtime    RuntimeConfig    `toml:"runtime"`
	Network    NetworkConfig    `toml:"network"`
	Images     ImagesConfig     `toml:"images"`
	Log        LogConfig        `toml:"log"`
}

type DaemonConfig struct {
	StateDir string `toml:"state_dir"`
	Socket   string `toml:"socket"`
}

type PoolConfig struct {
	IdleTimeout       Duration `toml:"idle_timeout"`
	DefaultMaxPerAgent int     `toml:"default_max_per_agent"`
}

type ContainerdConfig struct {
	Address   string `toml:"address"`
	Namespace string `toml:"namespace"`
}

type RuntimeConfig struct {
	Default     string            `toml:"default"`
	Firecracker RuntimeShimConfig `toml:"firecracker"`
	Runc        RuntimeShimConfig `toml:"runc"`
}

type RuntimeShimConfig struct {
	Name string `toml:"name"`
}

type NetworkConfig struct {
	CNIName string `toml:"cni_name"`
}

type ImagesConfig struct {
	Base string `toml:"base"`
}

type LogConfig struct {
	Level  string `toml:"level"`
	Format string `toml:"format"`
}

// Default returns a Config with the RFC-specified defaults.
func Default() *Config {
	return &Config{
		Version: 1,
		Daemon: DaemonConfig{
			StateDir: "/var/lib/nightshift",
			Socket:   "/run/nightshift/nightshiftd.sock",
		},
		Pool: PoolConfig{
			IdleTimeout:       Duration{5 * time.Minute},
			DefaultMaxPerAgent: 3,
		},
		Containerd: ContainerdConfig{
			Address:   "/run/containerd/containerd.sock",
			Namespace: "nightshift",
		},
		Runtime: RuntimeConfig{
			Default: "auto",
			Firecracker: RuntimeShimConfig{
				Name: "aws.firecracker",
			},
			Runc: RuntimeShimConfig{
				Name: "io.containerd.runc.v2",
			},
		},
		Network: NetworkConfig{
			CNIName: "nightshift",
		},
		Images: ImagesConfig{
			Base: "nightshift/agent-runtime:latest",
		},
		Log: LogConfig{
			Level:  "info",
			Format: "text",
		},
	}
}

// Load reads a TOML config file and decodes it on top of Default().
func Load(path string) (*Config, error) {
	cfg := Default()

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	return cfg, nil
}
