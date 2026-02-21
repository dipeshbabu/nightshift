"""Code review agent with subagents.

Demonstrates using Claude Agent SDK subagents through Nightshift.
A main orchestrator delegates specialised reviews (security, performance)
to lightweight subagents that each have their own tool set.

Usage:
    python examples/code_reviewer.py
"""

from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace="/home/ubuntu/my-project",
        vcpu_count=4,
        mem_size_mib=4096,
        timeout_seconds=3600,
    )
)
async def code_reviewer(prompt: str):
    """Review a codebase using specialised subagents."""
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["Read", "Glob", "Grep", "Task"],
            model="claude-opus-4-6",
            system_prompt=(
                "You are a senior staff engineer performing a thorough code review. "
                "Delegate security analysis to the security-reviewer agent and "
                "performance analysis to the perf-reviewer agent, then synthesise "
                "their findings into a single report."
            ),
            agents={
                "security-reviewer": AgentDefinition(
                    description="Security-focused code reviewer.",
                    prompt="Analyse the codebase for security vulnerabilities.",
                    tools=["Read", "Glob", "Grep"],
                ),
                "perf-reviewer": AgentDefinition(
                    description="Performance-focused code reviewer.",
                    prompt="Identify performance bottlenecks and suggest improvements.",
                    tools=["Read", "Glob", "Grep"],
                ),
            },
        ),
    ):
        yield message


if __name__ == "__main__":
    app.serve()
