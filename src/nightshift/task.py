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

import logging

from nightshift.config import NightshiftConfig
from nightshift.events import (
    CompletedEvent,
    ErrorEvent,
    EventLog,
)
from nightshift.protocol.packaging import cleanup_package, package_agent
from nightshift.sdk.app import RegisteredAgent
from nightshift.vm.manager import FirecrackerVM, VMConfig
from nightshift.vm.pool import VMPool

logger = logging.getLogger(__name__)

AGENT_PKG_DIR = "/opt/nightshift/agent_pkg"


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

        # Stage workspace into its own directory — only user files go here.
        # The agent package is passed separately via VMConfig and gets
        # copied to /opt/nightshift/agent_pkg in the overlay rootfs, keeping
        # it out of /workspace so the agent only sees user content.
        staging_dir = tempfile.mkdtemp(prefix="nightshift-staging-")
        shutil.copytree(
            workspace,
            staging_dir,
            symlinks=True,
            ignore_dangling_symlinks=True,
            dirs_exist_ok=True,
        )

        # Build env vars for the VM
        env_vars: dict[str, str] = {}
        for key in agent.config.forward_env:
            val = os.environ.get(key)
            if val:
                env_vars[key] = val
        env_vars.update(agent.config.env)
        env_vars["NIGHTSHIFT_WORKSPACE"] = "/workspace"
        env_vars["NIGHTSHIFT_AGENT_DIR"] = AGENT_PKG_DIR

        vm_config = VMConfig(
            kernel_path=config.kernel_path,
            base_rootfs_path=config.base_rootfs_path,
            workspace_path=staging_dir,
            agent_pkg_path=pkg_dir,
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


async def run_task_pooled(
    prompt: str,
    run_id: str,
    agent: RegisteredAgent,
    log: EventLog,
    pool: VMPool,
    agent_id: str,
    runtime_env: dict[str, str] | None = None,
) -> None:
    """Execute a task using the warm VM pool with retry on warm failure.

    Args:
        prompt:      The user's prompt text.
        run_id:      Unique identifier for this run.
        agent:       The registered agent to execute.
        log:         Event log for streaming events.
        pool:        The VM pool to checkout/checkin VMs.
        agent_id:    Agent identifier in the pool.
        runtime_env: Per-run env vars (e.g. API keys from the run request).
    """
    config = NightshiftConfig.from_env()

    try:
        for attempt in range(2):  # 1 retry after warm failure
            vm = await pool.checkout(agent_id, agent, config)
            try:
                await vm.submit_run(prompt, run_id, env_vars=runtime_env)
                await vm.wait_for_completion(log, run_id)
                logger.info("Run %s: wait_for_completion returned, checking in VM %s", run_id, vm.vm_id)
                await pool.checkin(agent_id, vm)
                logger.info("Run %s: checkin complete", run_id)
                return
            except Exception as exc:
                logger.warning(
                    "Run %s failed on VM %s (attempt %d), invalidating: %s",
                    run_id, vm.vm_id, attempt + 1, exc,
                )
                await pool.invalidate_vm(agent_id, vm)
                if attempt == 0:
                    continue  # retry with fresh VM
                raise
    except Exception as e:
        await log.publish(run_id, ErrorEvent(error=str(e)))
    finally:
        await log.cleanup(run_id)
