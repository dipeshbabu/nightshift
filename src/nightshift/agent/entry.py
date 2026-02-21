"""In-VM entry point.

Runs inside the Firecracker VM on boot. Reads a manifest,
dynamically imports the agent function, calls it with the prompt,
and streams each yielded message out via SSE on :8080.

Usage: python -m nightshift.agent
"""

from __future__ import annotations

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


async def run_agent() -> None:
    """Main entry point for the in-VM agent."""
    workspace = os.environ.get("NIGHTSHIFT_WORKSPACE", "/workspace")
    agent_dir = os.environ.get("NIGHTSHIFT_AGENT_DIR", "/opt/nightshift/agent_pkg")
    manifest_path = os.path.join(agent_dir, "manifest.json")

    # Read manifest
    with open(manifest_path) as f:
        manifest = json.load(f)

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
            subprocess.run(
                ["uv", "sync", "--project", agent_dir],
                cwd=agent_dir,
                check=True,
                capture_output=True,
            )

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
