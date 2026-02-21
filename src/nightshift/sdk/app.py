from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from collections.abc import Callable
from types import FunctionType
from typing import Any

from nightshift.sdk.config import AgentConfig


@dataclass
class RegisteredAgent:
    """An agent function registered with NightshiftApp."""

    name: str
    fn: Callable[..., Any]
    config: AgentConfig
    module_path: str


class NightshiftApp:
    """Main application class for registering and serving agents."""

    def __init__(self) -> None:
        self._agents: dict[str, RegisteredAgent] = {}

    def agent(self, config: AgentConfig | None = None, *, name: str | None = None):
        """Decorator to register an async generator function as an agent.

        Usage:
            @app.agent(AgentConfig(vcpu_count=2))
            async def my_agent(prompt: str):
                yield message
        """
        if config is None:
            config = AgentConfig()

        def decorator(fn: FunctionType) -> FunctionType:
            agent_name = name or fn.__name__
            module_path = inspect.getfile(fn)
            self._agents[agent_name] = RegisteredAgent(
                name=agent_name,
                fn=fn,
                config=config,
                module_path=module_path,
            )
            return fn

        return decorator

