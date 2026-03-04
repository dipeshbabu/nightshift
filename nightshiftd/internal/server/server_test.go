package server

import (
	"context"
	"io"
	"log/slog"
	"net"
	"testing"

	runtimev1 "github.com/nightshiftco/nightshift/nightshiftd/gen/nightshift/runtime/v1"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/config"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/db"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

var _ runtimev1.AgentRuntimeServer = (*Server)(nil)

var testDefaults = config.AgentDefaultsConfig{
	VcpuCount:      2,
	MemSizeMib:     512,
	TimeoutSeconds: 300,
	MaxConcurrent:  3,
	Sandbox:        "runc",
}

// testClient spins up a gRPC server with an in-memory DB and returns a connected client.
func testClient(t *testing.T) runtimev1.AgentRuntimeClient {
	t.Helper()

	d, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	srv := New(d, slog.Default(), testDefaults)
	gs := grpc.NewServer()
	srv.Register(gs)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go gs.Serve(lis)
	t.Cleanup(func() { gs.Stop() })

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })

	return runtimev1.NewAgentRuntimeClient(conn)
}

// testClientWithDB returns both a client and the underlying DB for inserting test fixtures.
func testClientWithDB(t *testing.T) (runtimev1.AgentRuntimeClient, *db.DB) {
	t.Helper()

	d, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })

	srv := New(d, slog.Default(), testDefaults)
	gs := grpc.NewServer()
	srv.Register(gs)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go gs.Serve(lis)
	t.Cleanup(func() { gs.Stop() })

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })

	return runtimev1.NewAgentRuntimeClient(conn), d
}

func assertCode(t *testing.T, err error, want codes.Code) {
	t.Helper()
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status error, got %v", err)
	}
	if st.Code() != want {
		t.Fatalf("expected %s, got %s: %s", want, st.Code(), st.Message())
	}
}

func TestDeployAndGetAgent(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	agent, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name:     "test-agent",
		ImageRef: "example.com/agent:v1",
		Overrides: &runtimev1.AgentConfigOverrides{
			VcpuCount:  2,
			MemSizeMib: 512,
		},
	})
	if err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	if agent.Name != "test-agent" {
		t.Fatalf("expected name test-agent, got %s", agent.Name)
	}
	if agent.ImageRef != "example.com/agent:v1" {
		t.Fatalf("expected image_ref, got %s", agent.ImageRef)
	}
	if agent.Id == "" {
		t.Fatal("expected non-empty id")
	}
	if agent.Config == nil || agent.Config.VcpuCount != 2 {
		t.Fatalf("expected vcpu_count 2, got %v", agent.Config)
	}
	if agent.CreatedAt == nil {
		t.Fatal("expected created_at")
	}

	// GetAgent round-trip
	got, err := client.GetAgent(ctx, &runtimev1.GetAgentRequest{Name: "test-agent"})
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.Id != agent.Id {
		t.Fatalf("expected id %s, got %s", agent.Id, got.Id)
	}
	if got.Config == nil || got.Config.VcpuCount != 2 {
		t.Fatalf("expected config with vcpu_count 2, got %v", got.Config)
	}
}

func TestDeployWithoutOverridesReturnsConfig(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	agent, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "bare", ImageRef: "img",
	})
	if err != nil {
		t.Fatal(err)
	}
	if agent.Config == nil {
		t.Fatal("expected config to be present even without overrides")
	}

	got, err := client.GetAgent(ctx, &runtimev1.GetAgentRequest{Name: "bare"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Config == nil {
		t.Fatal("expected GetAgent to return config")
	}
}

func TestDeployDuplicateName(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "dup", ImageRef: "img:v1",
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "dup", ImageRef: "img:v2",
	})
	assertCode(t, err, codes.AlreadyExists)
}

func TestDeployMissingFields(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.Deploy(ctx, &runtimev1.DeployRequest{ImageRef: "img"})
	assertCode(t, err, codes.InvalidArgument)

	_, err = client.Deploy(ctx, &runtimev1.DeployRequest{Name: "test"})
	assertCode(t, err, codes.InvalidArgument)
}

func TestGetAgentNotFound(t *testing.T) {
	client := testClient(t)
	_, err := client.GetAgent(context.Background(), &runtimev1.GetAgentRequest{Name: "nope"})
	assertCode(t, err, codes.NotFound)
}

func TestListAgents(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	for _, name := range []string{"alpha", "beta", "gamma"} {
		if _, err := client.Deploy(ctx, &runtimev1.DeployRequest{
			Name: name, ImageRef: "img",
		}); err != nil {
			t.Fatal(err)
		}
	}

	resp, err := client.ListAgents(ctx, &runtimev1.ListAgentsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Agents) != 3 {
		t.Fatalf("expected 3 agents, got %d", len(resp.Agents))
	}
}

func TestUpdateAgentMergesOverrides(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "updatable", ImageRef: "img",
		Overrides: &runtimev1.AgentConfigOverrides{
			VcpuCount:      2,
			TimeoutSeconds: 30,
			Env:            map[string]string{"FOO": "bar"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	updated, err := client.UpdateAgent(ctx, &runtimev1.UpdateAgentRequest{
		Name: "updatable",
		Overrides: &runtimev1.AgentConfigOverrides{
			VcpuCount: 4,
			Env:       map[string]string{"BAZ": "qux"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if updated.Config.VcpuCount != 4 {
		t.Fatalf("expected vcpu_count 4, got %d", updated.Config.VcpuCount)
	}
	if updated.Config.TimeoutSeconds != 30 {
		t.Fatalf("expected timeout_seconds 30 preserved, got %d", updated.Config.TimeoutSeconds)
	}
	if updated.Config.Env["FOO"] != "bar" {
		t.Fatalf("expected FOO=bar preserved, got %v", updated.Config.Env)
	}
	if updated.Config.Env["BAZ"] != "qux" {
		t.Fatalf("expected BAZ=qux added, got %v", updated.Config.Env)
	}
}

func TestUpdateAgentNotFound(t *testing.T) {
	client := testClient(t)
	_, err := client.UpdateAgent(context.Background(), &runtimev1.UpdateAgentRequest{
		Name: "nope",
	})
	assertCode(t, err, codes.NotFound)
}

func TestDeleteAgent(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "doomed", ImageRef: "img",
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.DeleteAgent(ctx, &runtimev1.DeleteAgentRequest{Name: "doomed"})
	if err != nil {
		t.Fatal(err)
	}

	// Verify gone
	_, err = client.GetAgent(ctx, &runtimev1.GetAgentRequest{Name: "doomed"})
	assertCode(t, err, codes.NotFound)
}

func TestDeleteAgentIdempotent(t *testing.T) {
	client := testClient(t)
	// Deleting non-existent agent should not error.
	_, err := client.DeleteAgent(context.Background(), &runtimev1.DeleteAgentRequest{Name: "nope"})
	if err != nil {
		t.Fatalf("expected idempotent delete, got %v", err)
	}
}

func TestCreateRunAndGetRun(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "runner", ImageRef: "img",
	})
	if err != nil {
		t.Fatal(err)
	}

	run, err := client.CreateRun(ctx, &runtimev1.CreateRunRequest{
		AgentName: "runner",
		Prompt:    "hello world",
	})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if run.Id == "" {
		t.Fatal("expected non-empty run id")
	}
	if run.AgentName != "runner" {
		t.Fatalf("expected agent_name runner, got %s", run.AgentName)
	}
	if run.Phase != runtimev1.RunPhase_RUN_PHASE_PENDING {
		t.Fatalf("expected PENDING, got %s", run.Phase)
	}

	// GetRun round-trip
	got, err := client.GetRun(ctx, &runtimev1.GetRunRequest{RunId: run.Id})
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if got.Id != run.Id {
		t.Fatalf("expected id %s, got %s", run.Id, got.Id)
	}
	if got.Phase != runtimev1.RunPhase_RUN_PHASE_PENDING {
		t.Fatalf("expected PENDING, got %s", got.Phase)
	}
}

func TestCreateRunUnknownAgent(t *testing.T) {
	client := testClient(t)
	_, err := client.CreateRun(context.Background(), &runtimev1.CreateRunRequest{
		AgentName: "nonexistent",
		Prompt:    "hello",
	})
	assertCode(t, err, codes.NotFound)
}

func TestCreateRunMissingFields(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.CreateRun(ctx, &runtimev1.CreateRunRequest{Prompt: "hello"})
	assertCode(t, err, codes.InvalidArgument)

	_, err = client.CreateRun(ctx, &runtimev1.CreateRunRequest{AgentName: "test"})
	assertCode(t, err, codes.InvalidArgument)
}

func TestGetRunNotFound(t *testing.T) {
	client := testClient(t)
	_, err := client.GetRun(context.Background(), &runtimev1.GetRunRequest{RunId: "nope"})
	assertCode(t, err, codes.NotFound)
}

func TestInterruptRunPending(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "agent", ImageRef: "img",
	})
	if err != nil {
		t.Fatal(err)
	}

	run, err := client.CreateRun(ctx, &runtimev1.CreateRunRequest{
		AgentName: "agent", Prompt: "hello",
	})
	if err != nil {
		t.Fatal(err)
	}

	interrupted, err := client.InterruptRun(ctx, &runtimev1.InterruptRunRequest{RunId: run.Id})
	if err != nil {
		t.Fatalf("InterruptRun: %v", err)
	}
	if interrupted.Phase != runtimev1.RunPhase_RUN_PHASE_INTERRUPTED {
		t.Fatalf("expected INTERRUPTED, got %s", interrupted.Phase)
	}
	if interrupted.CompletedAt == nil {
		t.Fatal("expected completed_at set on interrupt")
	}
}

func TestInterruptRunTerminalPhase(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()

	_, err := client.Deploy(ctx, &runtimev1.DeployRequest{
		Name: "agent", ImageRef: "img",
	})
	if err != nil {
		t.Fatal(err)
	}

	run, err := client.CreateRun(ctx, &runtimev1.CreateRunRequest{
		AgentName: "agent", Prompt: "hello",
	})
	if err != nil {
		t.Fatal(err)
	}

	// First interrupt succeeds.
	_, err = client.InterruptRun(ctx, &runtimev1.InterruptRunRequest{RunId: run.Id})
	if err != nil {
		t.Fatal(err)
	}

	// Second interrupt on already-interrupted run should fail.
	_, err = client.InterruptRun(ctx, &runtimev1.InterruptRunRequest{RunId: run.Id})
	assertCode(t, err, codes.FailedPrecondition)
}

func TestInterruptRunNotFound(t *testing.T) {
	client := testClient(t)
	_, err := client.InterruptRun(context.Background(), &runtimev1.InterruptRunRequest{RunId: "nope"})
	assertCode(t, err, codes.NotFound)
}

func TestStreamEventsReplay(t *testing.T) {
	client, d := testClientWithDB(t)
	ctx := context.Background()

	// Insert events directly into DB.
	for i, etype := range []string{"agent.start", "agent.message", "agent.end"} {
		_, err := d.Exec(
			`INSERT INTO run_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)`,
			"run-123", etype, `{"seq":`+string(rune('0'+i))+`}`, 1700000000.0+float64(i),
		)
		if err != nil {
			t.Fatal(err)
		}
	}

	stream, err := client.StreamEvents(ctx, &runtimev1.StreamEventsRequest{RunId: "run-123"})
	if err != nil {
		t.Fatalf("StreamEvents: %v", err)
	}

	var events []*runtimev1.Event
	for {
		ev, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Recv: %v", err)
		}
		events = append(events, ev)
	}

	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
	if events[0].EventType != "agent.start" {
		t.Fatalf("expected agent.start, got %s", events[0].EventType)
	}
	if events[2].EventType != "agent.end" {
		t.Fatalf("expected agent.end, got %s", events[2].EventType)
	}
	if events[0].RunId != "run-123" {
		t.Fatalf("expected run_id run-123, got %s", events[0].RunId)
	}
}

func TestStreamEventsEmpty(t *testing.T) {
	client := testClient(t)

	stream, err := client.StreamEvents(context.Background(), &runtimev1.StreamEventsRequest{RunId: "no-events"})
	if err != nil {
		t.Fatal(err)
	}

	_, err = stream.Recv()
	if err != io.EOF {
		t.Fatalf("expected EOF for empty stream, got %v", err)
	}
}
