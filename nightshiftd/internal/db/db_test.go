package db

import (
	"testing"
	"time"
)

func TestOpenInMemory(t *testing.T) {
	d, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open(:memory:) failed: %v", err)
	}
	defer d.Close()
}

func TestMigrateIdempotent(t *testing.T) {
	d, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	// Calling Migrate again should succeed (IF NOT EXISTS).
	if err := d.Migrate(); err != nil {
		t.Fatalf("second Migrate failed: %v", err)
	}
	if err := d.Migrate(); err != nil {
		t.Fatalf("third Migrate failed: %v", err)
	}
}

func TestInsertAgent(t *testing.T) {
	d, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	_, err = d.Exec(
		`INSERT INTO agents (id, name, image_ref, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		"agent-001", "my-agent", "registry.example.com/my-agent:latest", `{"vcpu_count":2}`, now, now,
	)
	if err != nil {
		t.Fatalf("insert agent: %v", err)
	}

	var name string
	err = d.QueryRow(`SELECT name FROM agents WHERE id = ?`, "agent-001").Scan(&name)
	if err != nil {
		t.Fatalf("query agent: %v", err)
	}
	if name != "my-agent" {
		t.Fatalf("expected my-agent, got %s", name)
	}
}

func TestInsertRun(t *testing.T) {
	d, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	_, err = d.Exec(
		`INSERT INTO runs (id, agent_id, prompt, phase, created_at) VALUES (?, ?, ?, ?, ?)`,
		"run-001", "agent-001", "hello", "pending", now,
	)
	if err != nil {
		t.Fatalf("insert run: %v", err)
	}

	var phase string
	err = d.QueryRow(`SELECT phase FROM runs WHERE id = ?`, "run-001").Scan(&phase)
	if err != nil {
		t.Fatalf("query run: %v", err)
	}
	if phase != "pending" {
		t.Fatalf("expected pending, got %s", phase)
	}
}

func TestInsertRunEvent(t *testing.T) {
	d, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	now := float64(time.Now().UnixMilli()) / 1000.0
	_, err = d.Exec(
		`INSERT INTO run_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
		"run-001", "agent.message", `{"text":"hi"}`, now,
	)
	if err != nil {
		t.Fatalf("insert run_event: %v", err)
	}

	var eventType string
	err = d.QueryRow(`SELECT event_type FROM run_events WHERE run_id = ?`, "run-001").Scan(&eventType)
	if err != nil {
		t.Fatalf("query run_event: %v", err)
	}
	if eventType != "agent.message" {
		t.Fatalf("expected agent.message, got %s", eventType)
	}
}
