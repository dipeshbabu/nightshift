package server

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	runtimev1 "github.com/nightshiftco/nightshift/nightshiftd/gen/nightshift/runtime/v1"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/config"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/db"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type Server struct {
	runtimev1.UnimplementedAgentRuntimeServer

	DB            *db.DB
	Log           *slog.Logger
	AgentDefaults config.AgentDefaultsConfig
}

func New(database *db.DB, logger *slog.Logger, agentDefaults config.AgentDefaultsConfig) *Server {
	return &Server{
		DB:            database,
		Log:           logger,
		AgentDefaults: agentDefaults,
	}
}

func (s *Server) Register(gs *grpc.Server) {
	runtimev1.RegisterAgentRuntimeServer(gs, s)
}

func (s *Server) Deploy(ctx context.Context, req *runtimev1.DeployRequest) (*runtimev1.Agent, error) {
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}
	if req.ImageRef == "" {
		return nil, status.Error(codes.InvalidArgument, "image_ref is required")
	}

	existing, err := s.DB.GetAgentByName(req.Name)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "lookup agent: %v", err)
	}
	if existing != nil {
		return nil, status.Errorf(codes.AlreadyExists, "agent %q already exists", req.Name)
	}

	now := time.Now().UTC()
	agentConfig := s.defaultConfig()
	if req.Overrides != nil {
		agentConfig = mergeOverrides(agentConfig, req.Overrides)
	}
	b, err := protojson.Marshal(agentConfig)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "marshal config: %v", err)
	}
	configJSON := string(b)

	row := db.AgentRow{
		ID:         uuid.New().String(),
		Name:       req.Name,
		ImageRef:   req.ImageRef,
		ConfigJSON: configJSON,
		CreatedAt:  now.Format(time.RFC3339),
		UpdatedAt:  now.Format(time.RFC3339),
	}
	if err := s.DB.InsertAgent(row); err != nil {
		if isUniqueViolation(err) {
			return nil, status.Errorf(codes.AlreadyExists, "agent %q already exists", req.Name)
		}
		return nil, status.Errorf(codes.Internal, "insert agent: %v", err)
	}

	return agentRowToProto(&row), nil
}

func (s *Server) GetAgent(ctx context.Context, req *runtimev1.GetAgentRequest) (*runtimev1.Agent, error) {
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}

	row, err := s.DB.GetAgentByName(req.Name)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "get agent: %v", err)
	}
	if row == nil {
		return nil, status.Errorf(codes.NotFound, "agent %q not found", req.Name)
	}

	return agentRowToProto(row), nil
}

func (s *Server) ListAgents(ctx context.Context, req *runtimev1.ListAgentsRequest) (*runtimev1.ListAgentsResponse, error) {
	rows, err := s.DB.ListAgents()
	if err != nil {
		return nil, status.Errorf(codes.Internal, "list agents: %v", err)
	}

	agents := make([]*runtimev1.Agent, len(rows))
	for i := range rows {
		agents[i] = agentRowToProto(&rows[i])
	}
	return &runtimev1.ListAgentsResponse{Agents: agents}, nil
}

func (s *Server) UpdateAgent(ctx context.Context, req *runtimev1.UpdateAgentRequest) (*runtimev1.Agent, error) {
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}

	existing, err := s.DB.GetAgentByName(req.Name)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "get agent: %v", err)
	}
	if existing == nil {
		return nil, status.Errorf(codes.NotFound, "agent %q not found", req.Name)
	}

	configJSON := existing.ConfigJSON
	if req.Overrides != nil {
		existingConfig := &runtimev1.AgentConfigOverrides{}
		if existing.ConfigJSON != "" && existing.ConfigJSON != "{}" {
			if err := protojson.Unmarshal([]byte(existing.ConfigJSON), existingConfig); err != nil {
				return nil, status.Errorf(codes.Internal, "unmarshal existing config: %v", err)
			}
		}

		merged := mergeOverrides(existingConfig, req.Overrides)
		b, err := protojson.Marshal(merged)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "marshal config: %v", err)
		}
		configJSON = string(b)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if err := s.DB.UpdateAgent(req.Name, existing.ImageRef, configJSON, now); err != nil {
		return nil, status.Errorf(codes.Internal, "update agent: %v", err)
	}

	existing.ConfigJSON = configJSON
	existing.UpdatedAt = now
	return agentRowToProto(existing), nil
}

func (s *Server) DeleteAgent(ctx context.Context, req *runtimev1.DeleteAgentRequest) (*emptypb.Empty, error) {
	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "name is required")
	}
	if err := s.DB.DeleteAgent(req.Name); err != nil {
		return nil, status.Errorf(codes.Internal, "delete agent: %v", err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) CreateRun(ctx context.Context, req *runtimev1.CreateRunRequest) (*runtimev1.Run, error) {
	if req.AgentName == "" {
		return nil, status.Error(codes.InvalidArgument, "agent_name is required")
	}
	if req.Prompt == "" {
		return nil, status.Error(codes.InvalidArgument, "prompt is required")
	}

	agent, err := s.DB.GetAgentByName(req.AgentName)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "get agent: %v", err)
	}
	if agent == nil {
		return nil, status.Errorf(codes.NotFound, "agent %q not found", req.AgentName)
	}

	now := time.Now().UTC()
	row := db.RunRow{
		ID:        uuid.New().String(),
		AgentID:   req.AgentName,
		Prompt:    req.Prompt,
		Phase:     "pending",
		CreatedAt: now.Format(time.RFC3339),
	}
	if err := s.DB.InsertRun(row); err != nil {
		return nil, status.Errorf(codes.Internal, "insert run: %v", err)
	}

	return runRowToProto(&row), nil
}

func (s *Server) GetRun(ctx context.Context, req *runtimev1.GetRunRequest) (*runtimev1.Run, error) {
	if req.RunId == "" {
		return nil, status.Error(codes.InvalidArgument, "run_id is required")
	}

	row, err := s.DB.GetRun(req.RunId)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "get run: %v", err)
	}
	if row == nil {
		return nil, status.Errorf(codes.NotFound, "run %q not found", req.RunId)
	}

	return runRowToProto(row), nil
}

func (s *Server) InterruptRun(ctx context.Context, req *runtimev1.InterruptRunRequest) (*runtimev1.Run, error) {
	if req.RunId == "" {
		return nil, status.Error(codes.InvalidArgument, "run_id is required")
	}

	row, err := s.DB.GetRun(req.RunId)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "get run: %v", err)
	}
	if row == nil {
		return nil, status.Errorf(codes.NotFound, "run %q not found", req.RunId)
	}

	if row.Phase != "pending" && row.Phase != "running" {
		return nil, status.Errorf(codes.FailedPrecondition, "run is in phase %q and cannot be interrupted", row.Phase)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if err := s.DB.UpdateRunPhase(req.RunId, "interrupted", &now, nil); err != nil {
		return nil, status.Errorf(codes.Internal, "update run: %v", err)
	}

	row.Phase = "interrupted"
	row.CompletedAt = &now
	return runRowToProto(row), nil
}

func (s *Server) StreamEvents(req *runtimev1.StreamEventsRequest, stream grpc.ServerStreamingServer[runtimev1.Event]) error {
	if req.RunId == "" {
		return status.Error(codes.InvalidArgument, "run_id is required")
	}

	events, err := s.DB.ListEventsByRunID(req.RunId)
	if err != nil {
		return status.Errorf(codes.Internal, "list events: %v", err)
	}

	for i := range events {
		if err := stream.Send(eventRowToProto(&events[i])); err != nil {
			return err
		}
	}

	return nil
}

func agentRowToProto(row *db.AgentRow) *runtimev1.Agent {
	agent := &runtimev1.Agent{
		Id:       row.ID,
		Name:     row.Name,
		ImageRef: row.ImageRef,
	}

	config := &runtimev1.AgentConfigOverrides{}
	if row.ConfigJSON != "" && row.ConfigJSON != "{}" {
		protojson.Unmarshal([]byte(row.ConfigJSON), config)
	}
	agent.Config = config

	if t, err := time.Parse(time.RFC3339, row.CreatedAt); err == nil {
		agent.CreatedAt = timestamppb.New(t)
	}
	if t, err := time.Parse(time.RFC3339, row.UpdatedAt); err == nil {
		agent.UpdatedAt = timestamppb.New(t)
	}

	return agent
}

func runRowToProto(row *db.RunRow) *runtimev1.Run {
	run := &runtimev1.Run{
		Id:        row.ID,
		AgentName: row.AgentID,
		Phase:     phaseStringToProto(row.Phase),
	}

	if t, err := time.Parse(time.RFC3339, row.CreatedAt); err == nil {
		run.CreatedAt = timestamppb.New(t)
	}
	if row.CompletedAt != nil {
		if t, err := time.Parse(time.RFC3339, *row.CompletedAt); err == nil {
			run.CompletedAt = timestamppb.New(t)
		}
	}
	if row.Error != nil {
		run.Error = *row.Error
	}

	return run
}

func eventRowToProto(row *db.EventRow) *runtimev1.Event {
	sec := int64(row.CreatedAt)
	nsec := int64((row.CreatedAt - float64(sec)) * 1e9)

	return &runtimev1.Event{
		RunId:     row.RunID,
		EventType: row.EventType,
		Payload:   []byte(row.PayloadJSON),
		Timestamp: &timestamppb.Timestamp{Seconds: sec, Nanos: int32(nsec)},
	}
}

var phaseToProto = map[string]runtimev1.RunPhase{
	"pending":     runtimev1.RunPhase_RUN_PHASE_PENDING,
	"running":     runtimev1.RunPhase_RUN_PHASE_RUNNING,
	"completed":   runtimev1.RunPhase_RUN_PHASE_COMPLETED,
	"error":       runtimev1.RunPhase_RUN_PHASE_ERROR,
	"interrupted": runtimev1.RunPhase_RUN_PHASE_INTERRUPTED,
}

func phaseStringToProto(s string) runtimev1.RunPhase {
	if p, ok := phaseToProto[s]; ok {
		return p
	}
	return runtimev1.RunPhase_RUN_PHASE_UNSPECIFIED
}

func mergeOverrides(existing, incoming *runtimev1.AgentConfigOverrides) *runtimev1.AgentConfigOverrides {
	merged := &runtimev1.AgentConfigOverrides{
		VcpuCount:      existing.GetVcpuCount(),
		MemSizeMib:     existing.GetMemSizeMib(),
		TimeoutSeconds: existing.GetTimeoutSeconds(),
		MaxConcurrent:  existing.GetMaxConcurrent(),
		Sandbox:        existing.GetSandbox(),
	}
	if existing.GetEnv() != nil {
		merged.Env = make(map[string]string)
		for k, v := range existing.GetEnv() {
			merged.Env[k] = v
		}
	}

	if incoming.VcpuCount != 0 {
		merged.VcpuCount = incoming.VcpuCount
	}
	if incoming.MemSizeMib != 0 {
		merged.MemSizeMib = incoming.MemSizeMib
	}
	if incoming.TimeoutSeconds != 0 {
		merged.TimeoutSeconds = incoming.TimeoutSeconds
	}
	if incoming.MaxConcurrent != 0 {
		merged.MaxConcurrent = incoming.MaxConcurrent
	}
	if incoming.Sandbox != "" {
		merged.Sandbox = incoming.Sandbox
	}
	if incoming.Env != nil {
		if merged.Env == nil {
			merged.Env = make(map[string]string)
		}
		for k, v := range incoming.Env {
			merged.Env[k] = v
		}
	}

	return merged
}

func (s *Server) defaultConfig() *runtimev1.AgentConfigOverrides {
	return &runtimev1.AgentConfigOverrides{
		VcpuCount:      s.AgentDefaults.VcpuCount,
		MemSizeMib:     s.AgentDefaults.MemSizeMib,
		TimeoutSeconds: s.AgentDefaults.TimeoutSeconds,
		MaxConcurrent:  s.AgentDefaults.MaxConcurrent,
		Sandbox:        s.AgentDefaults.Sandbox,
	}
}

func isUniqueViolation(err error) bool {
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}
