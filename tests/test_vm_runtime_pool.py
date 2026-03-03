from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Dict, Any

import pytest

from nightshift.config import NightshiftConfig
from nightshift.events import EventLog
from nightshift.sdk.app import RegisteredAgent
from nightshift.sdk.config import AgentConfig
from nightshift.vm.pool import VMPool
from nightshift.vm.runtime import SandboxDriver, SandboxInstance, RuntimeConfig
import nightshift.task as task_module


@dataclass
class FakeInstance(SandboxInstance):
    _instance_id: str
    started: bool = False
    destroyed: bool = False
    submit_calls: int = 0
    healthy: bool = True
    fail_first_submit: bool = False

    @property
    def instance_id(self) -> str:
        return self._instance_id

    async def start(self) -> None:
        self.started = True

    async def wait_for_completion(self, log: EventLog, run_id: str) -> None:
        # No-op for tests; real implementation streams events.
        return None

    async def submit_run(
        self,
        prompt: str,
        run_id: str,
        env_vars: Optional[Dict[str, str]] = None,
    ) -> None:
        self.submit_calls += 1
        if self.fail_first_submit and self.submit_calls == 1:
            raise RuntimeError("synthetic failure on first submit_run")

    async def copy_workspace_out(self, dest_path: str) -> None:
        return None

    async def destroy(self) -> None:
        self.destroyed = True

    def is_healthy(self) -> bool:
        return self.healthy

    async def is_healthy_async(self) -> bool:
        return self.healthy

    def get_serial_log(self) -> Optional[str]:
        return ""

    async def __aenter__(self) -> "FakeInstance":
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.destroy()


@dataclass
class FakeDriver(SandboxDriver):
    created: list[tuple[str, RuntimeConfig]] = field(default_factory=list)
    instances: list[FakeInstance] = field(default_factory=list)
    fail_first_submit: bool = False

    def create_instance(
        self,
        instance_id: str,
        config: RuntimeConfig,
    ) -> SandboxInstance:
        self.created.append((instance_id, config))
        inst = FakeInstance(
            _instance_id=instance_id,
            fail_first_submit=self.fail_first_submit,
        )
        self.instances.append(inst)
        return inst

    async def cleanup_stale_resources(self) -> None:
        return None


@pytest.mark.asyncio
async def test_vm_pool_uses_driver_create_and_start(tmp_path) -> None:
    """VMPool delegates instance creation and start to the injected driver."""
    driver = FakeDriver()
    pool = VMPool(driver=driver, idle_timeout=60, default_max_vms=1)

    agent_file = tmp_path / "agent.py"
    agent_file.write_text(
        "async def test_agent(prompt: str):\n    yield {'type': 'message', 'text': 'ok'}\n",
        encoding="utf-8",
    )

    cfg = NightshiftConfig(workspace=str(tmp_path))
    agent_cfg = AgentConfig(workspace=str(tmp_path))
    agent = RegisteredAgent(
        name="test_agent",
        fn=lambda prompt: None,
        config=agent_cfg,
        module_path=str(agent_file),
    )

    instance = await pool.checkout("agent-1", agent, cfg)

    assert isinstance(instance, FakeInstance)
    assert driver.created, "driver.create_instance should be called"
    assert instance.started is True

    await pool.shutdown()
    assert instance.destroyed is True


@pytest.mark.asyncio
async def test_run_task_retries_on_warm_failure(monkeypatch, tmp_path) -> None:
    """run_task retries once when a warm instance fails and uses the pool."""
    driver = FakeDriver(fail_first_submit=True)
    pool = VMPool(driver=driver, idle_timeout=60, default_max_vms=2)

    agent_file = tmp_path / "agent.py"
    agent_file.write_text(
        "async def test_agent(prompt: str):\n    yield {'type': 'message', 'text': 'ok'}\n",
        encoding="utf-8",
    )

    cfg = NightshiftConfig(workspace=str(tmp_path))
    monkeypatch.setattr(
        task_module.NightshiftConfig,
        "from_env",
        staticmethod(lambda: cfg),
    )

    agent_cfg = AgentConfig(workspace=str(tmp_path))
    agent = RegisteredAgent(
        name="test_agent",
        fn=lambda prompt: None,
        config=agent_cfg,
        module_path=str(agent_file),
    )

    log = EventLog()

    await task_module.run_task(
        prompt="hello",
        run_id="run-1",
        agent=agent,
        log=log,
        pool=pool,
        agent_id="agent-1",
        runtime_env=None,
        on_vm_acquired=None,
    )

    assert len(driver.instances) == 2
    assert driver.instances[0].submit_calls == 1
    assert driver.instances[1].submit_calls == 1

    await pool.shutdown()

