package db

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    image_ref TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
`

// DB wraps a sql.DB connected to nightshift's SQLite database.
type DB struct {
	*sql.DB
}

// Open connects to a SQLite database at the given path and runs migrations.
func Open(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// Enable WAL mode for concurrent read/write.
	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}

	db := &DB{sqlDB}
	if err := db.Migrate(); err != nil {
		sqlDB.Close()
		return nil, err
	}

	return db, nil
}

// Migrate applies the schema idempotently.
func (db *DB) Migrate() error {
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// Row types

type AgentRow struct {
	ID         string
	Name       string
	ImageRef   string
	ConfigJSON string
	CreatedAt  string // RFC3339
	UpdatedAt  string // RFC3339
}

type RunRow struct {
	ID          string
	AgentID     string
	Prompt      string
	Phase       string
	CreatedAt   string  // RFC3339
	CompletedAt *string // nullable
	Error       *string // nullable
}

type EventRow struct {
	ID          int64
	RunID       string
	EventType   string
	PayloadJSON string
	CreatedAt   float64 // unix seconds
}

// Agent methods

func (db *DB) InsertAgent(a AgentRow) error {
	_, err := db.Exec(
		`INSERT INTO agents (id, name, image_ref, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		a.ID, a.Name, a.ImageRef, a.ConfigJSON, a.CreatedAt, a.UpdatedAt,
	)
	return err
}

func (db *DB) GetAgentByName(name string) (*AgentRow, error) {
	row := db.QueryRow(
		`SELECT id, name, image_ref, config_json, created_at, updated_at FROM agents WHERE name = ?`, name,
	)
	a := &AgentRow{}
	err := row.Scan(&a.ID, &a.Name, &a.ImageRef, &a.ConfigJSON, &a.CreatedAt, &a.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (db *DB) ListAgents() ([]AgentRow, error) {
	rows, err := db.Query(
		`SELECT id, name, image_ref, config_json, created_at, updated_at FROM agents ORDER BY created_at`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var agents []AgentRow
	for rows.Next() {
		var a AgentRow
		if err := rows.Scan(&a.ID, &a.Name, &a.ImageRef, &a.ConfigJSON, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		agents = append(agents, a)
	}
	return agents, rows.Err()
}

func (db *DB) UpdateAgent(name, imageRef, configJSON, updatedAt string) error {
	_, err := db.Exec(
		`UPDATE agents SET image_ref = ?, config_json = ?, updated_at = ? WHERE name = ?`,
		imageRef, configJSON, updatedAt, name,
	)
	return err
}

func (db *DB) DeleteAgent(name string) error {
	_, err := db.Exec(`DELETE FROM agents WHERE name = ?`, name)
	return err
}

// Run methods

func (db *DB) InsertRun(r RunRow) error {
	_, err := db.Exec(
		`INSERT INTO runs (id, agent_id, prompt, phase, created_at) VALUES (?, ?, ?, ?, ?)`,
		r.ID, r.AgentID, r.Prompt, r.Phase, r.CreatedAt,
	)
	return err
}

func (db *DB) GetRun(id string) (*RunRow, error) {
	row := db.QueryRow(
		`SELECT id, agent_id, prompt, phase, created_at, completed_at, error FROM runs WHERE id = ?`, id,
	)
	r := &RunRow{}
	err := row.Scan(&r.ID, &r.AgentID, &r.Prompt, &r.Phase, &r.CreatedAt, &r.CompletedAt, &r.Error)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (db *DB) UpdateRunPhase(id, phase string, completedAt *string, runError *string) error {
	_, err := db.Exec(
		`UPDATE runs SET phase = ?, completed_at = ?, error = ? WHERE id = ?`,
		phase, completedAt, runError, id,
	)
	return err
}

// Event methods

func (db *DB) ListEventsByRunID(runID string) ([]EventRow, error) {
	rows, err := db.Query(
		`SELECT id, run_id, event_type, payload_json, created_at FROM run_events WHERE run_id = ? ORDER BY id`, runID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []EventRow
	for rows.Next() {
		var e EventRow
		if err := rows.Scan(&e.ID, &e.RunID, &e.EventType, &e.PayloadJSON, &e.CreatedAt); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}
