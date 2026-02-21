from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class NightshiftConfig:
    workspace: str = ""
    port: int = 3000
    kernel_path: str = "/opt/nightshift/vmlinux"
    base_rootfs_path: str = "/opt/nightshift/rootfs.ext4"
    vm_timeout_seconds: int = 1800  # 30 minutes
    vm_health_timeout_seconds: int = 60
    vm_event_port: int = 8080
    db_path: str = "/opt/nightshift/nightshift.db"
    agents_storage_dir: str = "/opt/nightshift/agents"

    @staticmethod
    def from_env() -> NightshiftConfig:
        return NightshiftConfig(
            workspace=os.environ.get("NIGHTSHIFT_WORKSPACE", os.getcwd()),
            port=int(os.environ.get("NIGHTSHIFT_PORT", "3000")),
            kernel_path=os.environ.get("NIGHTSHIFT_KERNEL_PATH", "/opt/nightshift/vmlinux"),
            base_rootfs_path=os.environ.get(
                "NIGHTSHIFT_ROOTFS_PATH", "/opt/nightshift/rootfs.ext4"
            ),
            db_path=os.environ.get("NIGHTSHIFT_DB_PATH", "/opt/nightshift/nightshift.db"),
            agents_storage_dir=os.environ.get(
                "NIGHTSHIFT_AGENTS_DIR", "/opt/nightshift/agents"
            ),
        )

    def env_vars_for_vm(self) -> dict[str, str]:
        """Collect platform env vars to pass into the VM."""
        env: dict[str, str] = {}
        env["NIGHTSHIFT_WORKSPACE"] = "/workspace"
        return env
