"""MCP agent — browser automation via Playwright.

Demonstrates integrating an MCP server with a Nightshift agent.
The Playwright MCP server gives the agent the ability to interact
with web pages programmatically.

Usage:
    python examples/mcp_agent.py
"""

from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace="/home/ubuntu/screenshots",
        vcpu_count=2,
        mem_size_mib=4096,
        timeout_seconds=1800,
    )
)
async def mcp_agent(prompt: str):
    """Interact with websites using browser automation."""
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["Read", "Write"],
            model="claude-opus-4-6",
            mcp_servers={
                "playwright": {
                    "command": "npx",
                    "args": ["@playwright/mcp@latest"],
                },
            },
            max_turns=15,
        ),
    ):
        yield message


if __name__ == "__main__":
    app.serve()
