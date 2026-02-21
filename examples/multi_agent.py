"""Multi-agent — register several agents on one server.

Demonstrates registering multiple agents with different configs
on a single NightshiftApp. Callers select which agent to run via
the `agent` field in the POST /prompt request body.

Usage:
    python examples/multi_agent.py

    # Then call a specific agent:
    curl -X POST http://localhost:3000/prompt \
        -H 'Content-Type: application/json' \
        -d '{"prompt": "Explain this repo", "agent": "explorer"}'
"""

from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace="/home/ubuntu/my-project",
        vcpu_count=2,
        mem_size_mib=2048,
    ),
    name="explorer",
)
async def explore_agent(prompt: str):
    """Lightweight read-only exploration of the codebase."""
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["Read", "Glob", "Grep"],
            model="claude-opus-4-6",
            max_turns=10,
        ),
    ):
        yield message


@app.agent(
    AgentConfig(
        workspace="/home/ubuntu/my-project",
        vcpu_count=4,
        mem_size_mib=4096,
        timeout_seconds=3600,
    ),
    name="builder",
)
async def build_agent(prompt: str):
    """Full read-write agent that can modify code and run tests."""
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
            permission_mode="acceptEdits",
            model="claude-opus-4-6",
            max_turns=30,
        ),
    ):
        yield message


if __name__ == "__main__":
    app.serve(port=3000)
