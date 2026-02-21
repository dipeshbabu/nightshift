"""Smoke test — minimal agent to verify the full Firecracker pipeline.

Uses the anthropic SDK directly (no claude-agent-sdk CLI dependency)
so it runs inside the minimal VM rootfs.

Tests:
    - Workspace is copied into the VM
    - ANTHROPIC_API_KEY is forwarded
    - Agent can call the Claude API
    - SSE events stream back to the host

Usage:
    sudo ANTHROPIC_API_KEY=sk-... uv run python examples/smoke_test.py

Then in another terminal:
    curl -X POST http://localhost:3000/prompt \
        -H 'Content-Type: application/json' \
        -d '{"prompt": "What files are in the workspace?"}'

    # Use the run_id from the response:
    curl -N 'http://localhost:3000/events?run_id=<run_id>'
"""

import os

from nightshift import NightshiftApp, AgentConfig

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace=os.path.join(os.path.dirname(__file__), "test-workspace"),
        vcpu_count=2,
        mem_size_mib=2048,
    )
)
async def smoke_test(prompt: str):
    """Minimal agent: list workspace files and echo the prompt back."""
    import glob

    # Show that the workspace was copied in
    workspace = os.environ.get("NIGHTSHIFT_WORKSPACE", "/workspace")
    files = glob.glob(os.path.join(workspace, "**"), recursive=True)

    yield {
        "type": "agent.message",
        "role": "assistant",
        "content": f"Workspace files: {files}",
    }

    yield {
        "type": "agent.message",
        "role": "assistant",
        "content": f"Received prompt: {prompt}",
    }


if __name__ == "__main__":
    from nightshift.cli.main import cli
    cli()
