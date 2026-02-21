"""Stateful agent — counter that persists across runs.

Demonstrates stateful VM reuse: each run increments a counter file
in /workspace. The counter persists across runs because the same VM
(and its overlay filesystem) is reused. On idle timeout, the workspace
is extracted back to the host.

No external API keys required — pure filesystem operations.

Usage:
    nightshift deploy examples/stateful_agent.py
"""

import os

from nightshift import NightshiftApp, AgentConfig

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace="test-workspace",
        vcpu_count=2,
        mem_size_mib=2048,
        stateful=True,
    )
)
async def stateful_agent(prompt: str):
    """Increment a counter file in the workspace on each run."""
    workspace = os.environ.get("NIGHTSHIFT_WORKSPACE", "/workspace")
    counter_path = os.path.join(workspace, "counter.txt")

    # Read current counter
    if os.path.exists(counter_path):
        with open(counter_path) as f:
            count = int(f.read().strip())
    else:
        count = 0

    # Increment
    count += 1

    # Write new counter
    with open(counter_path, "w") as f:
        f.write(str(count))

    # List workspace contents
    files = os.listdir(workspace)

    # Yield status message
    yield {
        "type": "agent.message",
        "role": "assistant",
        "content": f"Run #{count}. Prompt: '{prompt}'. Counter is now {count}. Workspace files: {files}",
    }
