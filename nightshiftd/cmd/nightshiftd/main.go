package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/nightshiftco/nightshift/nightshiftd/internal/config"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/db"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/server"
	"google.golang.org/grpc"
)

func main() {
	configPath := flag.String("config", "/etc/nightshift/config.toml", "path to config file")
	flag.Parse()

	if err := run(*configPath); err != nil {
		fmt.Fprintf(os.Stderr, "nightshiftd: %v\n", err)
		os.Exit(1)
	}
}

func run(configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	logger := setupLogger(cfg.Log)
	logger.Info("starting nightshiftd", "config", configPath)

	// state directory
	if err := os.MkdirAll(cfg.Daemon.StateDir, 0750); err != nil {
		return fmt.Errorf("create state_dir: %w", err)
	}

	// opn db and run migrations
	dbPath := filepath.Join(cfg.Daemon.StateDir, "nightshift.db")
	database, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer database.Close()
	logger.Info("database ready", "path", dbPath)

	// gRPC server and register service
	gs := grpc.NewServer()
	srv := server.New(database, logger, cfg.AgentDefaults)
	srv.Register(gs)

	var lis net.Listener
	if cfg.Daemon.Listen != "" {
		// TCP listener (for dev tools like Postman)
		lis, err = net.Listen("tcp", cfg.Daemon.Listen)
		if err != nil {
			return fmt.Errorf("listen on %s: %w", cfg.Daemon.Listen, err)
		}
		logger.Info("listening", "addr", cfg.Daemon.Listen)
	} else {
		socketPath := cfg.Daemon.Socket
		if err := os.MkdirAll(filepath.Dir(socketPath), 0755); err != nil {
			return fmt.Errorf("create socket dir: %w", err)
		}
		if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove stale socket: %w", err)
		}
		lis, err = net.Listen("unix", socketPath)
		if err != nil {
			return fmt.Errorf("listen on %s: %w", socketPath, err)
		}
		logger.Info("listening", "socket", socketPath)
	}

	// shutdown signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		logger.Info("received signal, shutting down", "signal", sig)
		gs.GracefulStop()
	}()

	if err := gs.Serve(lis); err != nil {
		return fmt.Errorf("serve: %w", err)
	}

	logger.Info("nightshiftd stopped")
	return nil
}

func setupLogger(cfg config.LogConfig) *slog.Logger {
	var level slog.Level
	switch cfg.Level {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: level}

	var handler slog.Handler
	if cfg.Format == "json" {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		handler = slog.NewTextHandler(os.Stderr, opts)
	}

	return slog.New(handler)
}
