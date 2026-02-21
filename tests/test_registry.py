"""Tests for the agent registry (SQLite-backed)."""

import pytest

from nightshift.registry import AgentRegistry


@pytest.fixture
async def registry(tmp_path):
    db_path = str(tmp_path / "test.db")
    reg = AgentRegistry(db_path)
    await reg.init_db()
    yield reg
    await reg.close()


@pytest.mark.asyncio
async def test_upsert_agent_creates_new(registry):
    agent = await registry.upsert_agent(
        tenant_id="t1",
        name="my_agent",
        source_filename="agent.py",
        function_name="my_agent",
        config_json='{"vcpu_count": 2}',
        storage_path="/opt/nightshift/agents/abc",
    )
    assert agent.name == "my_agent"
    assert agent.tenant_id == "t1"
    assert agent.id  # non-empty


@pytest.mark.asyncio
async def test_upsert_agent_updates_existing(registry):
    a1 = await registry.upsert_agent(
        tenant_id="t1", name="my_agent",
        source_filename="agent.py", function_name="my_agent",
        config_json='{"vcpu_count": 2}', storage_path="/opt/agents/a1",
    )
    a2 = await registry.upsert_agent(
        tenant_id="t1", name="my_agent",
        source_filename="agent_v2.py", function_name="my_agent",
        config_json='{"vcpu_count": 4}', storage_path="/opt/agents/a1",
    )
    assert a2.id == a1.id  # same record updated
    assert a2.source_filename == "agent_v2.py"
    assert a2.config_json == '{"vcpu_count": 4}'


@pytest.mark.asyncio
async def test_get_agent(registry):
    await registry.upsert_agent(
        tenant_id="t1", name="agent_x",
        source_filename="x.py", function_name="agent_x",
        config_json="{}", storage_path="/opt/agents/x",
    )
    agent = await registry.get_agent("t1", "agent_x")
    assert agent is not None
    assert agent.name == "agent_x"

    missing = await registry.get_agent("t1", "nonexistent")
    assert missing is None


@pytest.mark.asyncio
async def test_list_agents(registry):
    await registry.upsert_agent(
        tenant_id="t1", name="beta",
        source_filename="b.py", function_name="beta",
        config_json="{}", storage_path="/opt/agents/b",
    )
    await registry.upsert_agent(
        tenant_id="t1", name="alpha",
        source_filename="a.py", function_name="alpha",
        config_json="{}", storage_path="/opt/agents/a",
    )
    # Different tenant
    await registry.upsert_agent(
        tenant_id="t2", name="gamma",
        source_filename="g.py", function_name="gamma",
        config_json="{}", storage_path="/opt/agents/g",
    )

    agents = await registry.list_agents("t1")
    assert len(agents) == 2
    assert agents[0].name == "alpha"  # sorted by name
    assert agents[1].name == "beta"


@pytest.mark.asyncio
async def test_delete_agent(registry):
    await registry.upsert_agent(
        tenant_id="t1", name="to_delete",
        source_filename="d.py", function_name="to_delete",
        config_json="{}", storage_path="/opt/agents/d",
    )
    deleted = await registry.delete_agent("t1", "to_delete")
    assert deleted is True

    agent = await registry.get_agent("t1", "to_delete")
    assert agent is None

    # Deleting again returns False
    deleted = await registry.delete_agent("t1", "to_delete")
    assert deleted is False


@pytest.mark.asyncio
async def test_create_and_get_run(registry):
    agent = await registry.upsert_agent(
        tenant_id="t1", name="runner",
        source_filename="r.py", function_name="runner",
        config_json="{}", storage_path="/opt/agents/r",
    )
    run = await registry.create_run(agent.id, "t1", "Hello world")
    assert run.status == "started"
    assert run.prompt == "Hello world"

    fetched = await registry.get_run(run.id)
    assert fetched is not None
    assert fetched.id == run.id


@pytest.mark.asyncio
async def test_complete_run(registry):
    agent = await registry.upsert_agent(
        tenant_id="t1", name="runner",
        source_filename="r.py", function_name="runner",
        config_json="{}", storage_path="/opt/agents/r",
    )
    run = await registry.create_run(agent.id, "t1", "Hello")

    await registry.complete_run(run.id)
    fetched = await registry.get_run(run.id)
    assert fetched.status == "completed"
    assert fetched.completed_at is not None


@pytest.mark.asyncio
async def test_complete_run_with_error(registry):
    agent = await registry.upsert_agent(
        tenant_id="t1", name="runner",
        source_filename="r.py", function_name="runner",
        config_json="{}", storage_path="/opt/agents/r",
    )
    run = await registry.create_run(agent.id, "t1", "Hello")

    await registry.complete_run(run.id, error="something broke")
    fetched = await registry.get_run(run.id)
    assert fetched.status == "error"
    assert fetched.error == "something broke"


@pytest.mark.asyncio
async def test_api_key_storage_and_lookup(registry):
    await registry.store_api_key("hash123", "tenant_a", label="test key")

    tenant = await registry.get_tenant_by_key_hash("hash123")
    assert tenant == "tenant_a"

    missing = await registry.get_tenant_by_key_hash("unknown_hash")
    assert missing is None


@pytest.mark.asyncio
async def test_api_key_idempotent(registry):
    await registry.store_api_key("hash123", "tenant_a")
    await registry.store_api_key("hash123", "tenant_a")  # no error

    tenant = await registry.get_tenant_by_key_hash("hash123")
    assert tenant == "tenant_a"
