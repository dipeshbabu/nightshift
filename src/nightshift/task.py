"""Task orchestrator — boot VM, stream events, tear down.

Ties together VM lifecycle, agent packaging, and event forwarding.

Flow for a /prompt request:
    1. Package the agent source code for VM injection
    2. Boot a Firecracker VM with the packaged agent
    3. Stream SSE events from the VM agent until it finishes
    4. Tear down VM and clean up resources
"""

from __future__ import annotations

import os
import shutil
import tempfile

from nightshift.config import NightshiftConfig
from nightshift.events import (
    CompletedEvent,
    ErrorEvent,
    EventLog,
)
from nightshift.protocol.packaging import cleanup_package, package_agent
from nightshift.sdk.app import RegisteredAgent
from nightshift.vm.manager import FirecrackerVM, VMConfig

AGENT_PKG_SUBDIR = ".nightshift-agent"


async def run_task(
    prompt: str,
    run_id: str,
    agent: RegisteredAgent,
    log: EventLog,
) -> None:
    """Execute a task: package agent, boot VM, stream events, tear down.

    Args:
        prompt:  The user's prompt text.
        run_id:  Unique identifier for this run.
        agent:   The registered agent to execute.
        log:     Event log for streaming events.
    """
    config = NightshiftConfig.from_env()
    pkg_dir: str | None = None
    staging_dir: str | None = None
    vm: FirecrackerVM | None = None

    # Workspace from agent config takes priority, then platform config, then cwd
    workspace = agent.config.workspace or config.workspace or os.getcwd()

    try:
        # Package agent source code and manifest for VM injection
        pkg_dir = package_agent(
            module_path=agent.module_path,
            function_name=agent.name,
            prompt=prompt,
        )

        # Stage workspace + agent package into one directory.
        # The workspace contents become /workspace in the VM and the
        # agent package is nested at /workspace/.nightshift-agent.
        staging_dir = tempfile.mkdtemp(prefix="nightshift-staging-")
        shutil.copytree(
            workspace,
            staging_dir,
            symlinks=True,
            ignore_dangling_symlinks=True,
            dirs_exist_ok=True,
        )
        shutil.copytree(pkg_dir, os.path.join(staging_dir, AGENT_PKG_SUBDIR))

        # Build env vars for the VM
        env_vars: dict[str, str] = {}
        for key in agent.config.forward_env:
            val = os.environ.get(key)
            if val:
                env_vars[key] = val
        env_vars.update(agent.config.env)
        env_vars["NIGHTSHIFT_WORKSPACE"] = "/workspace"
        env_vars["NIGHTSHIFT_AGENT_DIR"] = f"/workspace/{AGENT_PKG_SUBDIR}"

        vm_config = VMConfig(
            kernel_path=config.kernel_path,
            base_rootfs_path=config.base_rootfs_path,
            workspace_path=staging_dir,
            env_vars=env_vars,
            vcpu_count=agent.config.vcpu_count,
            mem_size_mib=agent.config.mem_size_mib,
            event_port=config.vm_event_port,
            health_timeout=config.vm_health_timeout_seconds,
        )

        vm = FirecrackerVM(vm_id=run_id, config=vm_config)
        await vm.start()
        await vm.wait_for_completion(log, run_id)

        await log.publish(run_id, CompletedEvent())

    except Exception as e:
        await log.publish(run_id, ErrorEvent(error=str(e)))

    finally:
        if vm:
            await vm.destroy()
        if pkg_dir:
            cleanup_package(pkg_dir)
        if staging_dir:
            shutil.rmtree(staging_dir, ignore_errors=True)
        await log.cleanup(run_id)
