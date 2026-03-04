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

func testDB(t *testing.T) *DB {
	t.Helper()
	d, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestInsertAndGetAgent(t *testing.T) {
	d := testDB(t)
	now := time.Now().UTC().Format(time.RFC3339)

	row := AgentRow{
		ID:         "agent-001",
		Name:       "my-agent",
		ImageRef:   "registry.example.com/agent:latest",
		ConfigJSON: `{"vcpuCount":2}`,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := d.InsertAgent(row); err != nil {
		t.Fatalf("InsertAgent: %v", err)
	}

	got, err := d.GetAgentByName("my-agent")
	if err != nil {
		t.Fatalf("GetAgentByName: %v", err)
	}
	if got == nil {
		t.Fatal("expected agent, got nil")
	}
	if got.ID != "agent-001" {
		t.Fatalf("expected id agent-001, got %s", got.ID)
	}
	if got.ImageRef != "registry.example.com/agent:latest" {
		t.Fatalf("expected image_ref, got %s", got.ImageRef)
	}
	if got.ConfigJSON != `{"vcpuCount":2}` {
		t.Fatalf("expected config_json, got %s", got.ConfigJSON)
	}
}

func TestGetAgentNotFound(t *testing.T) {
	d := testDB(t)

	got, err := d.GetAgentByName("nonexistent")
	if err != nil {
		t.Fatalf("GetAgentByName: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestListAgents(t *testing.T) {
	d := testDB(t)
	now := time.Now().UTC().Format(time.RFC3339)

	for _, name := range []string{"alpha", "beta"} {
		if err := d.InsertAgent(AgentRow{
			ID: name + "-id", Name: name, ImageRef: "img",
			ConfigJSON: "{}", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}

	agents, err := d.ListAgents()
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 2 {
		t.Fatalf("expected 2 agents, got %d", len(agents))
	}
}

func TestUpdateAgent(t *testing.T) {
	d := testDB(t)
	now := time.Now().UTC().Format(time.RFC3339)

	if err := d.InsertAgent(AgentRow{
		ID: "a1", Name: "test", ImageRef: "old-img",
		ConfigJSON: `{"vcpuCount":1}`, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	later := time.Now().UTC().Add(time.Second).Format(time.RFC3339)
	if err := d.UpdateAgent("test", "new-img", `{"vcpuCount":4}`, later); err != nil {
		t.Fatal(err)
	}

	got, err := d.GetAgentByName("test")
	if err != nil {
		t.Fatal(err)
	}
	if got.ImageRef != "new-img" {
		t.Fatalf("expected new-img, got %s", got.ImageRef)
	}
	if got.ConfigJSON != `{"vcpuCount":4}` {
		t.Fatalf("expected updated config, got %s", got.ConfigJSON)
	}
	if got.UpdatedAt != later {
		t.Fatalf("expected updated_at %s, got %s", later, got.UpdatedAt)
	}
}

func TestDeleteAgent(t *testing.T) {
	d := testDB(t)
	now := time.Now().UTC().Format(time.RFC3339)

	if err := d.InsertAgent(AgentRow{
		ID: "a1", Name: "doomed", ImageRef: "img",
		ConfigJSON: "{}", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	if err := d.DeleteAgent("doomed"); err != nil {
		t.Fatal(err)
	}

	got, err := d.GetAgentByName("doomed")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil after delete, got %+v", got)
	}
}

func TestDeleteAgentIdempotent(t *testing.T) {
	d := testDB(t)
	// Deleting a non-existent agent should not error.
	if err := d.DeleteAgent("nonexistent"); err != nil {
		t.Fatal(err)
	}
}

func TestInsertAndGetRun(t *testing.T) {
	d := testDB(t)
	now := time.Now().UTC().Format(time.RFC3339)

	row := RunRow{
		ID:        "run-001",
		AgentID:   "my-agent",
		Prompt:    "hello world",
		Phase:     "pending",
		CreatedAt: now,
	}
	if err := d.InsertRun(row); err != nil {
		t.Fatalf("InsertRun: %v", err)
	}

	got, err := d.GetRun("run-001")
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if got == nil {
		t.Fatal("expected run, got nil")
	}
	if got.AgentID != "my-agent" {
		t.Fatalf("expected agent_id my-agent, got %s", got.AgentID)
	}
	if got.Phase != "pending" {
		t.Fatalf("expected phase pending, got %s", got.Phase)
	}
	if got.CompletedAt != nil {
		t.Fatalf("expected nil completed_at, got %v", got.CompletedAt)
	}
}

func TestGetRunNotFound(t *testing.T) {
	d := testDB(t)

	got, err := d.GetRun("nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

func TestUpdateRunPhase(t *testing.T) {
	d := testDB(t)
	now := time.Now().UTC().Format(time.RFC3339)

	if err := d.InsertRun(RunRow{
		ID: "run-001", AgentID: "agent", Prompt: "hi",
		Phase: "pending", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	completedAt := time.Now().UTC().Format(time.RFC3339)
	if err := d.UpdateRunPhase("run-001", "interrupted", &completedAt, nil); err != nil {
		t.Fatal(err)
	}

	got, err := d.GetRun("run-001")
	if err != nil {
		t.Fatal(err)
	}
	if got.Phase != "interrupted" {
		t.Fatalf("expected interrupted, got %s", got.Phase)
	}
	if got.CompletedAt == nil || *got.CompletedAt != completedAt {
		t.Fatalf("expected completed_at %s, got %v", completedAt, got.CompletedAt)
	}
}

func TestListEventsByRunID(t *testing.T) {
	d := testDB(t)
	now := float64(time.Now().UnixMilli()) / 1000.0

	// Insert events for two runs.
	for i, runID := range []string{"run-A", "run-A", "run-B"} {
		_, err := d.Exec(
			`INSERT INTO run_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
			runID, "msg", `{"i":`+string(rune('0'+i))+`}`, now+float64(i),
		)
		if err != nil {
			t.Fatal(err)
		}
	}

	events, err := d.ListEventsByRunID("run-A")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events for run-A, got %d", len(events))
	}
	if events[0].RunID != "run-A" {
		t.Fatalf("expected run-A, got %s", events[0].RunID)
	}
}

func TestListEventsByRunIDEmpty(t *testing.T) {
	d := testDB(t)

	events, err := d.ListEventsByRunID("nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}
