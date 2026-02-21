"""Web research agent.

Demonstrates an agent that can search the web, fetch pages, and write
its findings to the workspace. Uses WebSearch and WebFetch tools from
the Claude Agent SDK alongside file tools.

Usage:
    python examples/web_researcher.py
"""

from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace="/home/ubuntu/research-output",
        vcpu_count=2,
        mem_size_mib=2048,
        timeout_seconds=1800,
    )
)
async def web_researcher(prompt: str):
    """Research a topic on the web and write a report to the workspace."""
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["WebSearch", "WebFetch", "Read", "Write"],
            model="claude-opus-4-6",
            system_prompt=(
                "You are a research assistant. Search the web for information, "
                "synthesise your findings, and write a well-structured markdown "
                "report to /workspace/report.md."
            ),
            max_turns=20,
        ),
    ):
        yield message


if __name__ == "__main__":
    app.serve()
