"""Task orchestrator — boot VM, stream events, tear down.

Ties together VM lifecycle, agent packaging, and event forwarding.

Flow for a /prompt request:
    1. Package the agent source code for VM injection
    2. Boot a Firecracker VM with the packaged agent
    3. Stream SSE events from the VM agent until it finishes
    4. Tear down VM and clean up resources
"""

from __future__ import annotations

import asyncio

import logging
from typing import Awaitable, Callable

from nightshift.config import NightshiftConfig
from nightshift.events import ErrorEvent, EventLog
from nightshift.sdk.app import RegisteredAgent
from nightshift.vm.pool import VMPool
from nightshift.vm.runtime import SandboxInstance

logger = logging.getLogger(__name__)


async def run_task(
    prompt: str,
    run_id: str,
    agent: RegisteredAgent,
    log: EventLog,
    pool: VMPool,
    agent_id: str,
    runtime_env: dict[str, str] | None = None,
    on_vm_acquired: Callable[[], Awaitable[None]] | None = None,
) -> None:
    """Execute a task using the warm VM pool with retry on warm failure.

    Args:
        prompt:         The user's prompt text.
        run_id:         Unique identifier for this run.
        agent:          The registered agent to execute.
        log:            Event log for streaming events.
        pool:           The VM pool to checkout/checkin VMs.
        agent_id:       Agent identifier in the pool.
        runtime_env:    Per-run env vars (e.g. API keys from the run request).
        on_vm_acquired: Optional callback invoked once after pool.checkout()
                        returns (before submit_run). Used to transition
                        status from queued→running.
    """
    config = NightshiftConfig.from_env()

    try:
        for attempt in range(2):  # 1 retry after warm failure
            vm: SandboxInstance = await pool.checkout(agent_id, agent, config)
            try:
                if on_vm_acquired is not None:
                    await on_vm_acquired()
                    on_vm_acquired = None  # only invoke once

                await vm.submit_run(prompt, run_id, env_vars=runtime_env)
                await vm.wait_for_completion(log, run_id)
                logger.info(
                    "Run %s: wait_for_completion returned, checking in VM %s",
                    run_id,
                    vm.instance_id,
                )
                await pool.checkin(agent_id, vm)
                logger.info("Run %s: checkin complete", run_id)
                return
            except asyncio.CancelledError:
                logger.info(
                    "Run %s: cancelled while running on VM %s",
                    run_id,
                    vm.instance_id,
                )
                await pool.invalidate_vm(agent_id, vm)
                raise
            except Exception as exc:
                # Give the serial reader time to drain the full traceback
                await asyncio.sleep(2)
                serial = vm.get_serial_log()
                logger.warning(
                    "Run %s failed on VM %s (attempt %d): %s\n"
                    "--- serial log ---\n%s\n--- end serial log ---",
                    run_id,
                    vm.instance_id,
                    attempt + 1,
                    exc,
                    serial or "(empty)",
                )
                await pool.invalidate_vm(agent_id, vm)
                if attempt == 0:
                    continue  # retry with fresh VM
                raise
    except asyncio.CancelledError:
        raise
    except Exception as e:
        await log.publish(run_id, ErrorEvent(error=str(e)))
    finally:
        await log.cleanup(run_id)
