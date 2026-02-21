"""Platform server — /api/* endpoints for deploy, run, and stream.

Wires together the agent registry, auth, event buffer, and run_task bridge.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tarfile
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from nightshift.auth import bootstrap_api_key, generate_api_key, get_tenant_id, hash_api_key
from nightshift.config import NightshiftConfig
from nightshift.events import EventBuffer, StartedEvent
from nightshift.registry import AgentRecord, AgentRegistry
from nightshift.sdk.app import RegisteredAgent
from nightshift.sdk.config import AgentConfig
from nightshift.vm.network import cleanup_stale_taps
from nightshift.vm.pool import VMPool



_registry: AgentRegistry | None = None
_event_buffer: EventBuffer = EventBuffer()
_config: NightshiftConfig = NightshiftConfig()
_vm_pool: VMPool | None = None


def _get_registry() -> AgentRegistry:
    if _registry is None:
        raise RuntimeError("Server not initialized")
    return _registry


async def _auth_dependency(request: Request) -> str:
    """Extract tenant_id from Authorization header."""
    registry = _get_registry()
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")

    token = auth_header[7:]
    key_hash = hash_api_key(token)
    tenant_id = await registry.get_tenant_by_key_hash(key_hash)
    if tenant_id is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return tenant_id



@asynccontextmanager
async def lifespan(app: FastAPI):
    global _registry, _config, _vm_pool

    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

    _config = NightshiftConfig.from_env()

    os.makedirs(os.path.dirname(_config.db_path), exist_ok=True)
    os.makedirs(_config.agents_storage_dir, exist_ok=True)

    _registry = AgentRegistry(_config.db_path)
    await _registry.init_db()
    await bootstrap_api_key(_registry)

    await cleanup_stale_taps()

    _vm_pool = VMPool(
        idle_timeout=_config.vm_idle_timeout_seconds,
        default_max_vms=_config.vm_max_per_agent,
    )

    yield

    if _vm_pool:
        await _vm_pool.shutdown()
    await _registry.close()



app = FastAPI(title="Nightshift", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}



# ── API Keys ──────────────────────────────────────────────────

@app.post("/api/api-keys")
async def create_api_key(
    body: dict,
    tenant_id: str = Depends(_auth_dependency),
):
    """Generate a new API key. The raw key is returned once."""
    registry = _get_registry()
    target_tenant = body.get("tenant", tenant_id)
    label = body.get("label", "")

    raw_key = generate_api_key()
    key_hash = hash_api_key(raw_key)
    await registry.store_api_key(key_hash, target_tenant, label=label)

    return {"key": raw_key, "tenant": target_tenant, "label": label}


@app.get("/api/api-keys")
async def list_api_keys(tenant_id: str = Depends(_auth_dependency)):
    """List API keys for the caller's tenant."""
    registry = _get_registry()
    rows = await registry.db.execute_fetchall(
        "SELECT key_hash, tenant_id, label, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at",
        (tenant_id,),
    )
    return [
        {
            "hash_prefix": r[0][:12],
            "tenant": r[1],
            "label": r[2],
            "created_at": r[3],
        }
        for r in rows
    ]


@app.delete("/api/api-keys/{hash_prefix}")
async def revoke_api_key(
    hash_prefix: str,
    tenant_id: str = Depends(_auth_dependency),
):
    """Revoke an API key by its hash prefix."""
    registry = _get_registry()
    rows = await registry.db.execute_fetchall(
        "SELECT key_hash FROM api_keys WHERE key_hash LIKE ? AND tenant_id = ?",
        (f"{hash_prefix}%", tenant_id),
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"No key found matching prefix: {hash_prefix}")
    if len(rows) > 1:
        raise HTTPException(status_code=400, detail=f"Prefix '{hash_prefix}' matches {len(rows)} keys — be more specific")

    key_hash = rows[0][0]
    await registry.db.execute("DELETE FROM api_keys WHERE key_hash = ?", (key_hash,))
    await registry.db.commit()
    return {"status": "revoked", "hash_prefix": key_hash[:12]}


# ── Agents ────────────────────────────────────────────────────

@app.post("/api/agents")
async def deploy_agent(
    name: str = Form(),
    source_filename: str = Form(),
    function_name: str = Form(),
    config_json: str = Form(),
    archive: UploadFile = File(),
    workspace_archive: UploadFile | None = File(default=None),
    tenant_id: str = Depends(_auth_dependency),
):
    """Deploy an agent to the platform.

    Accepts a multipart form with agent metadata and a tar.gz archive
    of the project directory.  An optional *workspace_archive* (tar.gz)
    is extracted to ``{storage_path}/__workspace__/`` so that the agent
    can reference it at run time.
    """
    registry = _get_registry()

    # Validate config_json is valid JSON
    try:
        json.loads(config_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid config_json")

    # Check if agent already exists to reuse its ID
    existing = await registry.get_agent(tenant_id, name)
    if existing:
        agent_id = existing.id
        storage_path = existing.storage_path
    else:
        import uuid
        agent_id = str(uuid.uuid4())
        storage_path = os.path.join(_config.agents_storage_dir, agent_id)

    # Extract archive to storage path
    os.makedirs(storage_path, exist_ok=True)

    # Write uploaded tar.gz to a temp file, then extract
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        content = await archive.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Clear existing files before extracting new ones
        for entry in os.listdir(storage_path):
            entry_path = os.path.join(storage_path, entry)
            if os.path.isdir(entry_path):
                shutil.rmtree(entry_path)
            else:
                os.remove(entry_path)

        with tarfile.open(tmp_path, "r:gz") as tar:
            tar.extractall(storage_path, filter="data")
    finally:
        os.unlink(tmp_path)

    # Handle optional workspace archive
    if workspace_archive is not None:
        ws_dir = os.path.join(storage_path, "__workspace__")
        if os.path.isdir(ws_dir):
            shutil.rmtree(ws_dir)
        os.makedirs(ws_dir, exist_ok=True)

        with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
            ws_content = await workspace_archive.read()
            tmp.write(ws_content)
            ws_tmp_path = tmp.name

        try:
            with tarfile.open(ws_tmp_path, "r:gz") as tar:
                tar.extractall(ws_dir, filter="data")
        finally:
            os.unlink(ws_tmp_path)

    agent = await registry.upsert_agent(
        tenant_id=tenant_id,
        name=name,
        source_filename=source_filename,
        function_name=function_name,
        config_json=config_json,
        storage_path=storage_path,
        agent_id=agent_id,
    )

    # Invalidate warm VMs so next run cold-starts with new code
    if _vm_pool:
        await _vm_pool.invalidate_agent(agent.id)

    return JSONResponse(
        {"id": agent.id, "name": agent.name, "status": "deployed"},
        status_code=200,
    )


# ── List agents ───────────────────────────────────────────────

@app.get("/api/agents")
async def list_agents(tenant_id: str = Depends(_auth_dependency)):
    registry = _get_registry()
    agents = await registry.list_agents(tenant_id)
    return [
        {
            "id": a.id,
            "name": a.name,
            "source_filename": a.source_filename,
            "function_name": a.function_name,
            "created_at": a.created_at,
            "updated_at": a.updated_at,
        }
        for a in agents
    ]


# ── Delete agent ──────────────────────────────────────────────

@app.delete("/api/agents/{name}")
async def delete_agent(
    name: str,
    tenant_id: str = Depends(_auth_dependency),
):
    registry = _get_registry()
    agent = await registry.get_agent(tenant_id, name)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent not found: {name}")

    # Invalidate warm VMs before deleting
    if _vm_pool:
        await _vm_pool.invalidate_agent(agent.id)

    # Remove files
    if os.path.isdir(agent.storage_path):
        shutil.rmtree(agent.storage_path, ignore_errors=True)

    await registry.delete_agent(tenant_id, name)
    return {"status": "deleted", "name": name}


# ── Run agent ─────────────────────────────────────────────────

def _build_registered_agent(
    agent: AgentRecord, runtime_env: dict[str, str] | None = None
) -> RegisteredAgent:
    """Bridge a stored AgentRecord into a RegisteredAgent for run_task().

    When runtime_env is provided AND the pool is active, runtime_env is kept
    separate (passed to submit_run per request) — only static env goes into
    the agent config. For legacy non-pooled runs, runtime_env is still merged
    into the agent's env dict for backwards compatibility.
    """
    config_data = json.loads(agent.config_json)
    env = config_data.get("env", {})

    # For non-pooled (legacy) runs, merge runtime_env into static env.
    # For pooled runs, the caller passes runtime_env separately.
    if runtime_env and _vm_pool is None:
        env.update(runtime_env)

    workspace = config_data.get("workspace", "")
    if workspace == "__uploaded__":
        workspace = os.path.join(agent.storage_path, "__workspace__")

    agent_config = AgentConfig(
        workspace=workspace,
        vcpu_count=config_data.get("vcpu_count", 2),
        mem_size_mib=config_data.get("mem_size_mib", 2048),
        timeout_seconds=config_data.get("timeout_seconds", 1800),
        forward_env=config_data.get("forward_env", []),
        env=env,
        max_concurrent_vms=config_data.get("max_concurrent_vms", 0),
        stateful=config_data.get("stateful", False),
    )

    def _placeholder(prompt: str):
        raise RuntimeError("Placeholder — VM uses dynamic import")

    return RegisteredAgent(
        name=agent.function_name,
        fn=_placeholder,
        config=agent_config,
        module_path=os.path.join(agent.storage_path, agent.source_filename),
    )


@app.post("/api/agents/{name}/runs")
async def create_run(
    name: str,
    body: dict,
    tenant_id: str = Depends(_auth_dependency),
):
    """Start a new run for the given agent."""
    registry = _get_registry()

    prompt = body.get("prompt", "")
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    runtime_env: dict[str, str] = body.get("env", {})

    agent_record = await registry.get_agent(tenant_id, name)
    if not agent_record:
        raise HTTPException(status_code=404, detail=f"Agent not found: {name}")

    run = await registry.create_run(agent_record.id, tenant_id, prompt)

    await _event_buffer.publish(run.id, StartedEvent(workspace=agent_record.storage_path))

    # Launch task in background
    registered = _build_registered_agent(agent_record, runtime_env=runtime_env)
    asyncio.create_task(
        _run_agent_task(
            run.id, prompt, registered, registry,
            agent_id=agent_record.id, runtime_env=runtime_env,
        )
    )

    return JSONResponse({"id": run.id, "status": "started"}, status_code=202)


async def _run_agent_task(
    run_id: str,
    prompt: str,
    agent: RegisteredAgent,
    registry: AgentRegistry,
    agent_id: str = "",
    runtime_env: dict[str, str] | None = None,
) -> None:
    """Background task that runs an agent in a Firecracker VM.

    Uses the warm VM pool when available, falls back to one-shot run_task.
    """
    try:
        if _vm_pool and agent_id:
            from nightshift.task import run_task_pooled

            await run_task_pooled(
                prompt, run_id, agent, _event_buffer,
                pool=_vm_pool, agent_id=agent_id,
                runtime_env=runtime_env,
            )
        else:
            from nightshift.task import run_task

            await run_task(prompt, run_id, agent, _event_buffer)
        await registry.complete_run(run_id)
    except Exception as e:
        await registry.complete_run(run_id, error=str(e))


# ── Stream events ─────────────────────────────────────────────

@app.get("/api/runs/{run_id}/events")
async def stream_events(
    run_id: str,
    tenant_id: str = Depends(_auth_dependency),
):
    """SSE stream of events for a run."""
    registry = _get_registry()
    run = await registry.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Run not found")

    async def _stream_and_reap():
        async for event in _event_buffer.stream_sse(run_id):
            yield event
        _event_buffer.reap(run_id)

    return EventSourceResponse(_stream_and_reap())


# ── Server entry point ────────────────────────────────────────

async def start_server(host: str = "0.0.0.0", port: int = 3000) -> None:
    """Start the uvicorn server."""
    import uvicorn

    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()
