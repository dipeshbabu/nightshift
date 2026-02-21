"""SQLite-backed agent and run registry."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import aiosqlite


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _uuid() -> str:
    return str(uuid.uuid4())


@dataclass
class AgentRecord:
    id: str
    tenant_id: str
    name: str
    source_filename: str
    function_name: str
    config_json: str
    storage_path: str
    created_at: str
    updated_at: str


@dataclass
class RunRecord:
    id: str
    agent_id: str
    tenant_id: str
    prompt: str
    status: str
    created_at: str
    completed_at: str | None = None
    error: str | None = None


class AgentRegistry:
    """Async SQLite registry for agents, runs, and API keys."""

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._db: aiosqlite.Connection | None = None

    async def init_db(self) -> None:
        """Open the database and create tables if needed."""
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                name TEXT NOT NULL,
                source_filename TEXT NOT NULL,
                function_name TEXT NOT NULL,
                config_json TEXT NOT NULL,
                storage_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(tenant_id, name)
            );

            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                prompt TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'started',
                created_at TEXT NOT NULL,
                completed_at TEXT,
                error TEXT
            );

            CREATE TABLE IF NOT EXISTS api_keys (
                key_hash TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                label TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            """
        )
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("Database not initialized — call init_db() first")
        return self._db

    # ── Agents ────────────────────────────────────────────────────

    async def upsert_agent(
        self,
        tenant_id: str,
        name: str,
        source_filename: str,
        function_name: str,
        config_json: str,
        storage_path: str,
        agent_id: str | None = None,
    ) -> AgentRecord:
        """Insert or update an agent by (tenant_id, name)."""
        now = _now()
        if agent_id is None:
            agent_id = _uuid()

        # Check for existing agent with same (tenant_id, name)
        row = await self.db.execute_fetchall(
            "SELECT id, created_at FROM agents WHERE tenant_id = ? AND name = ?",
            (tenant_id, name),
        )
        if row:
            existing_id = row[0][0]
            existing_created = row[0][1]
            await self.db.execute(
                """UPDATE agents
                   SET source_filename = ?, function_name = ?, config_json = ?,
                       storage_path = ?, updated_at = ?
                   WHERE id = ?""",
                (source_filename, function_name, config_json, storage_path, now, existing_id),
            )
            await self.db.commit()
            return AgentRecord(
                id=existing_id,
                tenant_id=tenant_id,
                name=name,
                source_filename=source_filename,
                function_name=function_name,
                config_json=config_json,
                storage_path=storage_path,
                created_at=existing_created,
                updated_at=now,
            )

        await self.db.execute(
            """INSERT INTO agents (id, tenant_id, name, source_filename, function_name,
                                   config_json, storage_path, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (agent_id, tenant_id, name, source_filename, function_name,
             config_json, storage_path, now, now),
        )
        await self.db.commit()
        return AgentRecord(
            id=agent_id,
            tenant_id=tenant_id,
            name=name,
            source_filename=source_filename,
            function_name=function_name,
            config_json=config_json,
            storage_path=storage_path,
            created_at=now,
            updated_at=now,
        )

    async def get_agent(self, tenant_id: str, name: str) -> AgentRecord | None:
        rows = await self.db.execute_fetchall(
            "SELECT * FROM agents WHERE tenant_id = ? AND name = ?",
            (tenant_id, name),
        )
        if not rows:
            return None
        r = rows[0]
        return AgentRecord(
            id=r[0], tenant_id=r[1], name=r[2], source_filename=r[3],
            function_name=r[4], config_json=r[5], storage_path=r[6],
            created_at=r[7], updated_at=r[8],
        )

    async def list_agents(self, tenant_id: str) -> list[AgentRecord]:
        rows = await self.db.execute_fetchall(
            "SELECT * FROM agents WHERE tenant_id = ? ORDER BY name",
            (tenant_id,),
        )
        return [
            AgentRecord(
                id=r[0], tenant_id=r[1], name=r[2], source_filename=r[3],
                function_name=r[4], config_json=r[5], storage_path=r[6],
                created_at=r[7], updated_at=r[8],
            )
            for r in rows
        ]

    async def delete_agent(self, tenant_id: str, name: str) -> bool:
        cursor = await self.db.execute(
            "DELETE FROM agents WHERE tenant_id = ? AND name = ?",
            (tenant_id, name),
        )
        await self.db.commit()
        return cursor.rowcount > 0

    # ── Runs ──────────────────────────────────────────────────────

    async def create_run(
        self,
        agent_id: str,
        tenant_id: str,
        prompt: str,
    ) -> RunRecord:
        run_id = _uuid()
        now = _now()
        await self.db.execute(
            """INSERT INTO runs (id, agent_id, tenant_id, prompt, status, created_at)
               VALUES (?, ?, ?, ?, 'started', ?)""",
            (run_id, agent_id, tenant_id, prompt, now),
        )
        await self.db.commit()
        return RunRecord(
            id=run_id,
            agent_id=agent_id,
            tenant_id=tenant_id,
            prompt=prompt,
            status="started",
            created_at=now,
        )

    async def complete_run(self, run_id: str, error: str | None = None) -> None:
        now = _now()
        status = "error" if error else "completed"
        await self.db.execute(
            "UPDATE runs SET status = ?, completed_at = ?, error = ? WHERE id = ?",
            (status, now, error, run_id),
        )
        await self.db.commit()

    async def get_run(self, run_id: str) -> RunRecord | None:
        rows = await self.db.execute_fetchall(
            "SELECT * FROM runs WHERE id = ?", (run_id,),
        )
        if not rows:
            return None
        r = rows[0]
        return RunRecord(
            id=r[0], agent_id=r[1], tenant_id=r[2], prompt=r[3],
            status=r[4], created_at=r[5], completed_at=r[6], error=r[7],
        )

    # ── API Keys ──────────────────────────────────────────────────

    async def store_api_key(self, key_hash: str, tenant_id: str, label: str = "") -> None:
        await self.db.execute(
            """INSERT OR IGNORE INTO api_keys (key_hash, tenant_id, label, created_at)
               VALUES (?, ?, ?, ?)""",
            (key_hash, tenant_id, label, _now()),
        )
        await self.db.commit()

    async def get_tenant_by_key_hash(self, key_hash: str) -> str | None:
        rows = await self.db.execute_fetchall(
            "SELECT tenant_id FROM api_keys WHERE key_hash = ?",
            (key_hash,),
        )
        if not rows:
            return None
        return rows[0][0]
