"""Hooks agent — audit logging for file changes.

Demonstrates using Claude Agent SDK hooks to log every file
modification the agent makes. A PostToolUse hook fires after
each Edit or Write, appending an entry to an audit log.

Usage:
    python examples/hooks_agent.py
"""

from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions, HookMatcher

app = NightshiftApp()


async def log_file_change(input_data, tool_use_id, context):
    """Append a line to /workspace/audit.log after each file edit."""
    import datetime

    file_path = input_data.get("tool_input", {}).get("file_path", "unknown")
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open("/workspace/audit.log", "a") as f:
        f.write(f"{ts}  modified  {file_path}\n")
    return {}


@app.agent(
    AgentConfig(
        workspace="/home/ubuntu/my-project",
        vcpu_count=2,
        mem_size_mib=2048,
    )
)
async def hooks_agent(prompt: str):
    """Refactor code with an audit trail of every change."""
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["Read", "Edit", "Write", "Glob", "Grep"],
            permission_mode="acceptEdits",
            model="claude-opus-4-6",
            hooks={
                "PostToolUse": [
                    HookMatcher(
                        matcher="Edit|Write",
                        hooks=[log_file_change],
                    )
                ],
            },
            max_turns=20,
        ),
    ):
        yield message


if __name__ == "__main__":
    app.serve()
