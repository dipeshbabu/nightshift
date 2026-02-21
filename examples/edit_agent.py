"""Edit agent — autonomous code modification.

Demonstrates an agent with write access that can read, edit, and run
tests in the workspace. Uses acceptEdits permission mode so file
modifications are applied without interactive prompts.

Usage:
    python examples/edit_agent.py
"""

from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions

app = NightshiftApp()


@app.agent(
    AgentConfig(
        workspace="/home/ubuntu/my-project",
        vcpu_count=4,
        mem_size_mib=4096,
        timeout_seconds=3600,
        forward_env=["ANTHROPIC_API_KEY"],
    )
)
async def edit_agent(prompt: str):
    """Modify code and verify changes pass tests."""
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
            permission_mode="acceptEdits",
            model="claude-opus-4-6",
            system_prompt=(
                "You are an expert software engineer. Make the requested changes, "
                "then run the project's test suite to verify nothing is broken. "
                "If tests fail, fix the issues before finishing."
            ),
            max_turns=30,
        ),
    ):
        yield message


if __name__ == "__main__":
    app.serve()
