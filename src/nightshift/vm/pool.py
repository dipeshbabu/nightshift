"""Multi-VM pool with keep-alive, idle timeout, and horizontal scaling.

Manages a pool of warm Firecracker VMs per agent. Each VM handles one run
at a time. When all warm VMs are busy and under the concurrency limit, a
new VM is cold-started. When at the limit, requests queue until a VM
becomes available.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass, field

from nightshift.config import NightshiftConfig
from nightshift.protocol.packaging import cleanup_package, package_agent
from nightshift.sdk.app import RegisteredAgent
from nightshift.vm.manager import FirecrackerVM, VMConfig

logger = logging.getLogger(__name__)

AGENT_PKG_DIR = "/opt/nightshift/agent_pkg"


@dataclass
class _PoolEntry:
    """Tracks a single VM in the pool."""

    vm: FirecrackerVM | None
    agent_id: str
    pkg_dir: str
    staging_dir: str
    workspace_dest: str  # original workspace path on host
    stateful: bool
    busy: bool = False
    idle_task: asyncio.Task | None = field(default=None, repr=False)


class VMPool:
    """Multi-VM pool with checkout/checkin, idle timeout, and scaling."""

    def __init__(self, idle_timeout: int, default_max_vms: int) -> None:
        self._agents: dict[str, list[_PoolEntry]] = {}
        self._idle_timeout = idle_timeout
        self._default_max_vms = default_max_vms
        self._cond = asyncio.Condition()

    async def checkout(
        self,
        agent_id: str,
        agent: RegisteredAgent,
        config: NightshiftConfig,
    ) -> FirecrackerVM:
        """Get a warm VM or cold-start a new one.

        Blocks if all VMs are busy and at the concurrency limit.
        Returns a ready-to-use FirecrackerVM.
        """
        # Resolve effective max concurrency
        if agent.config.stateful:
            effective_max = 1
        elif agent.config.max_concurrent_vms > 0:
            effective_max = agent.config.max_concurrent_vms
        else:
            effective_max = self._default_max_vms

        entry: _PoolEntry | None = None
        cold_start = False

        async with self._cond:
            while True:
                entries = self._agents.setdefault(agent_id, [])

                # 1. Find an idle (not busy) entry with a live VM
                for e in entries:
                    if not e.busy and e.vm is not None:
                        e.busy = True
                        if e.idle_task:
                            e.idle_task.cancel()
                            e.idle_task = None
                        entry = e
                        break

                if entry is not None:
                    break

                # 2. No idle entry but under the limit → create placeholder
                if len(entries) < effective_max:
                    workspace = agent.config.workspace or config.workspace
                    if not workspace:
                        # Empty workspace: create a minimal temp dir rather than
                        # falling back to cwd (which is "/" under systemd).
                        workspace = tempfile.mkdtemp(prefix="nightshift-empty-ws-")
                    entry = _PoolEntry(
                        vm=None,
                        agent_id=agent_id,
                        pkg_dir="",
                        staging_dir="",
                        workspace_dest=workspace,
                        stateful=agent.config.stateful,
                        busy=True,
                    )
                    entries.append(entry)
                    cold_start = True
                    break

                # 3. At limit → wait for a checkin or invalidation
                await self._cond.wait()

        # Warm hit — health check
        if not cold_start and entry is not None:
            assert entry.vm is not None
            healthy = await entry.vm.is_healthy_async()
            if not healthy:
                logger.warning("Warm VM %s unhealthy, removing", entry.vm.vm_id)
                await self._remove_entry(agent_id, entry)
                raise RuntimeError(
                    f"Warm VM unhealthy for agent {agent_id}"
                )
            return entry.vm

        # Cold start — provision a new VM
        assert entry is not None
        try:
            vm = await self._cold_start(entry, agent, config)
            entry.vm = vm
            return vm
        except Exception:
            # Clean up the placeholder on failure
            async with self._cond:
                entries = self._agents.get(agent_id, [])
                if entry in entries:
                    entries.remove(entry)
                self._cond.notify_all()
            raise

    async def checkin(self, agent_id: str, vm: FirecrackerVM) -> None:
        """Return a VM to the pool after a successful run."""
        logger.info("Checkin VM %s for agent %s", vm.vm_id, agent_id)
        async with self._cond:
            entries = self._agents.get(agent_id, [])
            for e in entries:
                if e.vm is vm:
                    e.busy = False
                    e.idle_task = asyncio.create_task(
                        self._idle_expire(agent_id, e)
                    )
                    logger.info(
                        "VM %s checked in, idle timer started (%ds)",
                        vm.vm_id, self._idle_timeout,
                    )
                    break
            else:
                logger.warning("Checkin: VM %s not found in pool for agent %s", vm.vm_id, agent_id)
            self._cond.notify_all()

    async def invalidate_vm(self, agent_id: str, vm: FirecrackerVM) -> None:
        """Destroy one specific VM (e.g. on error during a run)."""
        async with self._cond:
            entries = self._agents.get(agent_id, [])
            target = None
            for e in entries:
                if e.vm is vm:
                    target = e
                    break
            if target:
                entries.remove(target)
                self._cond.notify_all()

        if target:
            await self._destroy_entry(target)

    async def invalidate_agent(self, agent_id: str) -> None:
        """Destroy ALL VMs for an agent (e.g. on redeploy or delete)."""
        async with self._cond:
            entries = self._agents.pop(agent_id, [])
            self._cond.notify_all()

        for e in entries:
            await self._destroy_entry(e)

    async def shutdown(self) -> None:
        """Destroy all VMs across all agents (server exit)."""
        async with self._cond:
            all_agents = dict(self._agents)
            self._agents.clear()
            self._cond.notify_all()

        for agent_id, entries in all_agents.items():
            for e in entries:
                await self._destroy_entry(e)

    # ── Internal helpers ──────────────────────────────────────────

    async def _cold_start(
        self,
        entry: _PoolEntry,
        agent: RegisteredAgent,
        config: NightshiftConfig,
    ) -> FirecrackerVM:
        """Provision a new VM from scratch."""
        workspace = entry.workspace_dest

        # Package agent in a thread (synchronous file I/O)
        pkg_dir = await asyncio.to_thread(
            package_agent,
            module_path=agent.module_path,
            function_name=agent.name,
            prompt=None,
        )
        entry.pkg_dir = pkg_dir

        # Stage workspace in a thread (synchronous copytree)
        staging_dir = tempfile.mkdtemp(prefix="nightshift-staging-")
        await asyncio.to_thread(
            shutil.copytree,
            workspace,
            staging_dir,
            symlinks=True,
            ignore_dangling_symlinks=True,
            dirs_exist_ok=True,
        )
        entry.staging_dir = staging_dir

        # Build static env vars (forward_env + agent.config.env + NIGHTSHIFT_*)
        env_vars = _build_static_env_vars(agent, config)

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

        vm_id = str(uuid.uuid4())
        vm = FirecrackerVM(vm_id=vm_id, config=vm_config)
        await vm.start()

        logger.info("Cold-started VM %s for agent %s", vm_id, entry.agent_id)
        return vm

    async def _idle_expire(self, agent_id: str, entry: _PoolEntry) -> None:
        """Idle timer: destroy the VM after timeout if still idle."""
        try:
            await asyncio.sleep(self._idle_timeout)
        except asyncio.CancelledError:
            return

        # Only destroy if still idle (not reclaimed by checkout)
        async with self._cond:
            entries = self._agents.get(agent_id, [])
            if entry not in entries or entry.busy:
                return
            entries.remove(entry)
            self._cond.notify_all()

        logger.info(
            "Idle timeout: destroying VM %s for agent %s",
            entry.vm.vm_id if entry.vm else "?",
            agent_id,
        )
        await self._destroy_entry(entry)

    async def _remove_entry(self, agent_id: str, entry: _PoolEntry) -> None:
        """Remove an entry from the pool and destroy it."""
        async with self._cond:
            entries = self._agents.get(agent_id, [])
            if entry in entries:
                entries.remove(entry)
            self._cond.notify_all()
        await self._destroy_entry(entry)

    async def _destroy_entry(self, entry: _PoolEntry) -> None:
        """Destroy a single pool entry: extract workspace if stateful, then cleanup."""
        if entry.idle_task:
            entry.idle_task.cancel()
            entry.idle_task = None

        if entry.vm:
            try:
                if entry.stateful:
                    logger.info("Extracting workspace for stateful VM %s → %s", entry.vm.vm_id, entry.workspace_dest)
                    await entry.vm.copy_workspace_out(entry.workspace_dest)
                    logger.info("Workspace extracted for VM %s", entry.vm.vm_id)
            except Exception:
                logger.exception(
                    "Failed to extract workspace for VM %s", entry.vm.vm_id
                )
            try:
                logger.info("Destroying VM %s", entry.vm.vm_id)
                await entry.vm.destroy()
                logger.info("VM %s destroyed", entry.vm.vm_id)
            except Exception:
                logger.exception("Failed to destroy VM %s", entry.vm.vm_id)

        if entry.pkg_dir:
            cleanup_package(entry.pkg_dir)
        if entry.staging_dir:
            shutil.rmtree(entry.staging_dir, ignore_errors=True)
        logger.info("Pool entry cleanup complete for agent %s", entry.agent_id)


def _build_static_env_vars(
    agent: RegisteredAgent,
    config: NightshiftConfig,
) -> dict[str, str]:
    """Build env vars that are baked into the VM at boot time.

    Includes forward_env, agent.config.env, and NIGHTSHIFT_* platform vars.
    Per-run env vars (from the run request) are sent via POST /run instead.
    """
    env_vars: dict[str, str] = {}
    for key in agent.config.forward_env:
        val = os.environ.get(key)
        if val:
            env_vars[key] = val
    env_vars.update(agent.config.env)
    env_vars["NIGHTSHIFT_WORKSPACE"] = "/workspace"
    env_vars["NIGHTSHIFT_AGENT_DIR"] = AGENT_PKG_DIR
    return env_vars
