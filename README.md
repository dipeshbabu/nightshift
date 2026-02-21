<p align="center">
  <img src="docs/logo/kokapo.gif" alt="Kokapo" width="120" />
</p>

<p align="center">
  <img src="docs/logo/nightshift-text.png" alt="Nightshift" width="400" />
</p>

<p align="center">
  Turn Coding Agents into autonomous knowledge workers.
</p>

<p align="center">
  <a href="https://pypi.org/project/nightshift-sdk/"><img src="https://img.shields.io/pypi/v/nightshift-sdk" alt="PyPI" /></a>
</p>

<p align="center">
  <a href="https://nightshift.sh">Website</a> &middot;
  <a href="https://docs.nightshift.sh">Docs</a> &middot;
  <a href="https://join.slack.com/t/nightshiftoss/shared_invite/zt-3p5dshiiq-hjB8558QvURDgqqCI7e8RQ">Slack</a>
</p>

---

# Nightshift

Autonomous agent orchestrator with Firecracker VM isolation.

Nightshift runs AI agents in isolated [Firecracker](https://firecracker-microvm.github.io/) microVMs on bare-metal infrastructure. Each agent gets its own VM with a dedicated filesystem, network, and resource limits — so agents can execute code, edit files, and make network calls without affecting the host or each other.

## Installation

```bash
uv add nightshift-sdk
```

or

```bash
pip install nightshift-sdk
```

## Quick Start

Define an agent with `NightshiftApp` and `AgentConfig`:

```python
from nightshift import NightshiftApp, AgentConfig
from claude_agent_sdk import query, ClaudeAgentOptions

app = NightshiftApp()

@app.agent(
    AgentConfig(
        workspace="./my-project",
        vcpu_count=2,
        mem_size_mib=2048,
        timeout_seconds=1800,
    )
)
async def code_reviewer(prompt: str):
    async for message in query(
        prompt=prompt,
        options=ClaudeAgentOptions(
            cwd="/workspace",
            allowed_tools=["Read", "Glob", "Grep"],
            model="claude-sonnet-4-6",
        ),
    ):
        yield message
```

Deploy to a Nightshift platform:

```bash
nightshift login --url https://api.nightshift.sh
nightshift deploy agent.py
nightshift run code_reviewer --prompt "Review the auth module for security issues"
```

Or run locally on a machine with Firecracker:

```bash
nightshift run code_reviewer agent.py --prompt "Review the auth module"
```

## AgentConfig

| Parameter | Default | Description |
|-----------|---------|-------------|
| `workspace` | `""` | Host directory to mount into the VM at `/workspace` |
| `vcpu_count` | `2` | Number of vCPUs allocated to the VM |
| `mem_size_mib` | `2048` | Memory in MiB allocated to the VM |
| `timeout_seconds` | `1800` | Maximum agent execution time (30 min default) |
| `forward_env` | `[]` | Environment variables to forward from host |
| `env` | `{}` | Static environment variables set in the VM |

## Documentation

Full documentation at [docs.nightshift.sh](https://docs.nightshift.sh).

## License

Apache 2.0 — see [LICENSE](LICENSE).
