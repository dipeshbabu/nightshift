from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable, Dict, Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from nightshift.events import EventLog


@dataclass
class RuntimeConfig:
    """Backend-agnostic configuration for a single runtime instance."""

    # Host directory to mount or inject as the instance's /workspace.
    workspace_path: str

    # Host directory containing the packaged agent code.
    agent_pkg_path: str = ""

    # Environment variables to inject into the instance.
    env_vars: Dict[str, str] = field(default_factory=dict)

    # Resource limits. Drivers may ignore these if the backend does not
    # support fine-grained resource control.
    vcpu_count: int = 2
    mem_size_mib: int = 2048

    # Maximum seconds to wait for the instance to become healthy.
    health_timeout: int = 60


@runtime_checkable
class SandboxInstance(Protocol):
    """Handle to a single running sandbox (VM, container, process, and so on)."""

    @property
    def instance_id(self) -> str:
        """Unique identifier for this instance."""
        ...

    async def start(self) -> None:
        """Provision resources and boot the instance."""
        ...

    async def wait_for_completion(self, log: "EventLog", run_id: str) -> None:
        """Stream events from the instance until a terminal event."""
        ...

    async def submit_run(
        self,
        prompt: str,
        run_id: str,
        env_vars: Optional[Dict[str, str]] = None,
    ) -> None:
        ...

    async def copy_workspace_out(self, dest_path: str) -> None:
        """Extract the modified workspace from the instance to dest_path."""
        ...

    async def destroy(self) -> None:
        """Tear down all resources associated with this instance."""
        ...

    def is_healthy(self) -> bool:
        """Quick synchronous liveness check."""
        ...

    async def is_healthy_async(self) -> bool:
        """Full async health check."""
        ...

    def get_serial_log(self) -> Optional[str]:
        """Return debug output captured from the instance, if any."""
        ...

    async def __aenter__(self) -> "SandboxInstance":
        ...

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        ...


@runtime_checkable
class SandboxDriver(Protocol):
    """Factory that creates SandboxInstance objects and cleans up stale resources."""

    def create_instance(
        self,
        instance_id: str,
        config: RuntimeConfig,
    ) -> SandboxInstance:
        """Create a new sandbox instance (not yet started)."""
        ...

    async def cleanup_stale_resources(self) -> None:
        """Clean up orphaned resources from a previous server process."""
        ...

