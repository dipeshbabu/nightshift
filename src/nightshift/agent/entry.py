"""In-VM entry point.

Runs inside the Firecracker VM on boot. Reads a manifest,
dynamically imports the agent function, calls it with the prompt,
and streams each yielded message out via SSE on :8080.

Two modes, selected by manifest content:
  - One-shot: manifest has "prompt" key → run once and exit (legacy/CLI).
  - Multi-run server: no "prompt" → long-running HTTP server accepting
    POST /run with per-run prompt and env vars (warm VM pool).

Usage: python -m nightshift.agent
"""

import asyncio
import importlib
import json
import os
import subprocess
import sys

from nightshift.events import (
    CompletedEvent,
    ErrorEvent,
    EventLog,
    StartedEvent,
)
from nightshift.protocol.events import serialize_message

# ── Module-level state for multi-run server mode ──────────────

_agent_fn = None
_initialized = False
_run_lock = asyncio.Lock()
_log = EventLog()
_current_run_id: str | None = None


async def _ensure_initialized(manifest: dict, agent_dir: str) -> None:
    """Install deps and import agent module on first run (idempotent)."""
    global _agent_fn, _initialized
    if _initialized:
        return

    if manifest.get("has_pyproject"):
        _install_agent_deps(agent_dir)

    if agent_dir not in sys.path:
        sys.path.insert(0, agent_dir)

    mod = importlib.import_module(manifest["module"])
    _agent_fn = getattr(mod, manifest["function"])
    _initialized = True


def _install_agent_deps(agent_dir: str) -> None:
    """Install agent dependencies into the running Python environment.

    Uses ``uv pip install`` directly instead of ``uv sync`` to avoid
    requires-python conflicts (the agent may target a newer Python than
    the VM provides). Dependencies are extracted from pyproject.toml and
    installed into the current interpreter's site-packages.
    """
    import tomllib

    pyproject_path = os.path.join(agent_dir, "pyproject.toml")
    with open(pyproject_path, "rb") as f:
        pyproject = tomllib.load(f)

    deps = pyproject.get("project", {}).get("dependencies", [])
    if not deps:
        return

    subprocess.run(
        ["uv", "pip", "install", "--python", sys.executable] + deps,
        cwd=agent_dir,
        check=True,
        capture_output=True,
    )


async def _execute_run(prompt: str, run_id: str, manifest: dict, agent_dir: str) -> None:
    """Execute a single agent run under the run lock."""
    workspace = os.environ.get("NIGHTSHIFT_WORKSPACE", "/workspace")

    async with _run_lock:
        try:
            await _ensure_initialized(manifest, agent_dir)

            await _log.publish(run_id, StartedEvent(workspace=workspace))

            async for message in _agent_fn(prompt):
                data = serialize_message(message)
                event_type = data.get("type", "agent.message")
                await _log.publish_raw(run_id, event_type, data)

            await _log.publish(run_id, CompletedEvent())

        except Exception as e:
            await _log.publish(run_id, ErrorEvent(error=str(e)))

        finally:
            # Mark the run as done so stream consumers finish
            await _log.cleanup(run_id)


# ── HTTP server (shared by both modes) ────────────────────────

async def serve_events(log: EventLog, run_id: str = "vm", port: int = 8080) -> None:
    """Serve an HTTP /events SSE endpoint for the host to subscribe to."""
    import uvicorn
    from fastapi import FastAPI
    from sse_starlette.sse import EventSourceResponse

    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/events")
    async def events():
        return EventSourceResponse(log.stream(run_id))

    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning")
    server = uvicorn.Server(config)
    await server.serve()


async def serve_multi_run(manifest: dict, agent_dir: str, port: int = 8080) -> None:
    """Long-running server accepting POST /run for warm VM pool mode."""
    import uvicorn
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from sse_starlette.sse import EventSourceResponse

    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/run")
    async def run(request: Request):
        body = await request.json()
        prompt = body.get("prompt", "")
        run_id = body.get("run_id", "vm")
        env_vars: dict[str, str] = body.get("env", {})

        if not prompt:
            return JSONResponse({"error": "prompt is required"}, status_code=400)

        # Reject if already busy
        if _run_lock.locked():
            return JSONResponse(
                {"error": "VM is busy with another run"},
                status_code=409,
            )

        # Apply per-run env vars
        for k, v in env_vars.items():
            os.environ[k] = v

        global _current_run_id

        # Reap previous run's events
        if _current_run_id and _current_run_id != run_id:
            _log.reap(_current_run_id)

        # Set run ID immediately so /events can connect before the task starts
        _current_run_id = run_id

        # Launch run in background
        asyncio.create_task(_execute_run(prompt, run_id, manifest, agent_dir))

        return JSONResponse({"status": "accepted", "run_id": run_id}, status_code=202)

    @app.get("/events")
    async def events():
        if _current_run_id is None:
            return JSONResponse({"error": "no active run"}, status_code=404)
        return EventSourceResponse(_log.stream_sse(_current_run_id))

    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning")
    server = uvicorn.Server(config)
    await server.serve()


# ── One-shot mode (legacy) ────────────────────────────────────

async def run_agent() -> None:
    """Main entry point for the in-VM agent."""
    workspace = os.environ.get("NIGHTSHIFT_WORKSPACE", "/workspace")
    agent_dir = os.environ.get("NIGHTSHIFT_AGENT_DIR", "/opt/nightshift/agent_pkg")
    manifest_path = os.path.join(agent_dir, "manifest.json")

    # Read manifest
    with open(manifest_path) as f:
        manifest = json.load(f)

    # Multi-run server mode: no prompt baked into manifest
    if "prompt" not in manifest:
        await serve_multi_run(manifest, agent_dir, port=8080)
        return

    # One-shot mode: prompt is in the manifest
    module_name = manifest["module"]
    function_name = manifest["function"]
    prompt = manifest["prompt"]

    log = EventLog()
    run_id = "vm"

    # Start event server in background
    event_server_task = asyncio.create_task(serve_events(log, run_id=run_id, port=8080))
    await asyncio.sleep(0.5)

    try:
        await log.publish(
            run_id,
            StartedEvent(workspace=workspace),
        )

        # Install agent dependencies from pyproject.toml if present
        if manifest.get("has_pyproject"):
            _install_agent_deps(agent_dir)

        # Add agent dir to sys.path and import the agent module
        if agent_dir not in sys.path:
            sys.path.insert(0, agent_dir)
        mod = importlib.import_module(module_name)
        agent_fn = getattr(mod, function_name)

        # Call the agent function (async generator) and stream messages
        async for message in agent_fn(prompt):
            data = serialize_message(message)
            event_type = data.get("type", "agent.message")
            await log.publish_raw(run_id, event_type, data)

        await log.publish(run_id, CompletedEvent())

    except Exception as e:
        await log.publish(run_id, ErrorEvent(error=str(e)))

    finally:
        await asyncio.sleep(1)
        event_server_task.cancel()
        try:
            await event_server_task
        except asyncio.CancelledError:
            pass


def main() -> None:
    asyncio.run(run_agent())


if __name__ == "__main__":
    main()
