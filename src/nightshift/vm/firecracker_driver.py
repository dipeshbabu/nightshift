from __future__ import annotations

from dataclasses import dataclass

from nightshift.vm.manager import VMConfig, FirecrackerVM
from nightshift.vm.network import cleanup_stale_taps
from nightshift.vm.runtime import RuntimeConfig, SandboxDriver, SandboxInstance


@dataclass
class FirecrackerDriver(SandboxDriver):
    """SandboxDriver implementation for Firecracker microVMs.

    This is a thin adapter that maps the generic RuntimeConfig into the existing
    Firecracker VMConfig and returns an unstarted FirecrackerVM.
    """

    kernel_path: str
    base_rootfs_path: str
    event_port: int = 8080

    def create_instance(
        self,
        instance_id: str,
        config: RuntimeConfig,
    ) -> SandboxInstance:
        vm_config = VMConfig(
            kernel_path=self.kernel_path,
            base_rootfs_path=self.base_rootfs_path,
            workspace_path=config.workspace_path,
            agent_pkg_path=config.agent_pkg_path,
            env_vars=config.env_vars,
            vcpu_count=config.vcpu_count,
            mem_size_mib=config.mem_size_mib,
            event_port=self.event_port,
            health_timeout=config.health_timeout,
        )
        return FirecrackerVM(vm_id=instance_id, config=vm_config)

    async def cleanup_stale_resources(self) -> None:
        """Remove leftover TAP devices and related resources from prior runs."""
        await cleanup_stale_taps()

