package server

import (
	"context"
	"log/slog"
	"net"
	"testing"

	runtimev1 "github.com/nightshiftco/nightshift/nightshiftd/gen/nightshift/runtime/v1"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/db"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

var _ runtimev1.AgentRuntimeServer = (*Server)(nil)

func TestDeployReturnsUnimplemented(t *testing.T) {
	d, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	srv := New(d, slog.Default())

	gs := grpc.NewServer()
	srv.Register(gs)

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go gs.Serve(lis)
	defer gs.Stop()

	conn, err := grpc.NewClient(
		lis.Addr().String(),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	client := runtimev1.NewAgentRuntimeClient(conn)
	_, err = client.Deploy(context.Background(), &runtimev1.DeployRequest{
		Name:     "test-agent",
		ImageRef: "example.com/agent:latest",
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected gRPC status error, got %v", err)
	}
	if st.Code() != codes.Unimplemented {
		t.Fatalf("expected Unimplemented, got %s", st.Code())
	}
}
