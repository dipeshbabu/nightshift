from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class AgentConfig:
    """Configuration for a registered agent's VM resources and environment."""

    workspace: str = ""
    vcpu_count: int = 2
    mem_size_mib: int = 2048
    timeout_seconds: int = 1800
    forward_env: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    max_concurrent_vms: int = 0  # 0 = use platform default; >0 = explicit limit
    stateful: bool = False  # True = single VM, serial, workspace extracted on teardown
