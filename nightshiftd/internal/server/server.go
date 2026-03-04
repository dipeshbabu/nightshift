package server

import (
	"log/slog"

	runtimev1 "github.com/nightshiftco/nightshift/nightshiftd/gen/nightshift/runtime/v1"
	"github.com/nightshiftco/nightshift/nightshiftd/internal/db"
	"google.golang.org/grpc"
)

type Server struct {
	runtimev1.UnimplementedAgentRuntimeServer

	DB  *db.DB
	Log *slog.Logger
}

func New(database *db.DB, logger *slog.Logger) *Server {
	return &Server{
		DB:  database,
		Log: logger,
	}
}

func (s *Server) Register(gs *grpc.Server) {
	runtimev1.RegisterAgentRuntimeServer(gs, s)
}
