"""Basic agent — read-only codebase Q&A.

Demonstrates the simplest Nightshift + Claude Agent SDK integration.
The workspace is defined in AgentConfig so the VM mounts the correct
directory and the agent's cwd points to it.

Usage:
    python examples/basic_agent.py
"""

from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace="test-workspace",
        vcpu_count=2,
        mem_size_mib=2048,
        # max_concurrent_vms=2,
        stateful=True,
    )
)
async def basic_agent(prompt: str):
    """Answer questions about a codebase using read-only tools."""
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
