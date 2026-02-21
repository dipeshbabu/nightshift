"""Tests for the platform /api/* endpoints."""

import io
import json
import os
import tarfile

import pytest
from httpx import ASGITransport, AsyncClient

from nightshift.auth import hash_api_key
from nightshift.registry import AgentRegistry
from nightshift.server import app, _auth_dependency
import nightshift.server as srv


TEST_API_KEY = "ns_test1234567890abcdef1234567890abcdef"
TEST_TENANT = "test-tenant"


@pytest.fixture
async def setup_server(tmp_path):
    """Set up registry and override auth for testing."""
    db_path = str(tmp_path / "test.db")
    agents_dir = str(tmp_path / "agents")
    os.makedirs(agents_dir, exist_ok=True)

    registry = AgentRegistry(db_path)
    await registry.init_db()

    # Store the test API key
    await registry.store_api_key(hash_api_key(TEST_API_KEY), TEST_TENANT)

    # Override module-level state
    srv._registry = registry
    srv._config.agents_storage_dir = agents_dir
    srv._config.db_path = db_path

    yield registry

    await registry.close()
    srv._registry = None


def _make_archive(files: dict[str, str]) -> bytes:
    """Create a tar.gz archive in memory from a dict of filename -> content."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    buf.seek(0)
    return buf.read()


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TEST_API_KEY}"}


@pytest.mark.asyncio
async def test_health(setup_server):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_deploy_agent(setup_server, tmp_path):
    archive = _make_archive({
        "agent.py": "async def my_agent(prompt): yield 'hello'",
        "pyproject.toml": '[project]\nname = "test"',
    })

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/api/agents",
            data={
                "name": "my_agent",
                "source_filename": "agent.py",
                "function_name": "my_agent",
                "config_json": json.dumps({"vcpu_count": 2}),
            },
            files={"archive": ("archive.tar.gz", archive, "application/gzip")},
            headers=_auth_headers(),
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "my_agent"
        assert data["status"] == "deployed"
        assert "id" in data

        # Agent ID and storage directory name must match
        agent_id = data["id"]
        agent_record = await setup_server.get_agent(TEST_TENANT, "my_agent")
        assert agent_record.id == agent_id
        assert agent_record.storage_path.endswith(agent_id)


@pytest.mark.asyncio
async def test_deploy_agent_updates_existing(setup_server):
    archive = _make_archive({"agent.py": "v1"})
    archive_v2 = _make_archive({"agent.py": "v2"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r1 = await client.post(
            "/api/agents",
            data={
                "name": "updater",
                "source_filename": "agent.py",
                "function_name": "updater",
                "config_json": "{}",
            },
            files={"archive": ("a.tar.gz", archive, "application/gzip")},
            headers=_auth_headers(),
        )
        r2 = await client.post(
            "/api/agents",
            data={
                "name": "updater",
                "source_filename": "agent.py",
                "function_name": "updater",
                "config_json": "{}",
            },
            files={"archive": ("a.tar.gz", archive_v2, "application/gzip")},
            headers=_auth_headers(),
        )
        assert r1.json()["id"] == r2.json()["id"]


@pytest.mark.asyncio
async def test_list_agents(setup_server):
    archive = _make_archive({"agent.py": "pass"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        # Deploy two agents
        for name in ["alpha", "beta"]:
            await client.post(
                "/api/agents",
                data={
                    "name": name,
                    "source_filename": "agent.py",
                    "function_name": name,
                    "config_json": "{}",
                },
                files={"archive": ("a.tar.gz", archive, "application/gzip")},
                headers=_auth_headers(),
            )

        r = await client.get("/api/agents", headers=_auth_headers())
        assert r.status_code == 200
        agents = r.json()
        assert len(agents) == 2
        names = [a["name"] for a in agents]
        assert "alpha" in names
        assert "beta" in names


@pytest.mark.asyncio
async def test_delete_agent(setup_server):
    archive = _make_archive({"agent.py": "pass"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        await client.post(
            "/api/agents",
            data={
                "name": "deleteme",
                "source_filename": "agent.py",
                "function_name": "deleteme",
                "config_json": "{}",
            },
            files={"archive": ("a.tar.gz", archive, "application/gzip")},
            headers=_auth_headers(),
        )

        r = await client.delete("/api/agents/deleteme", headers=_auth_headers())
        assert r.status_code == 200
        assert r.json()["status"] == "deleted"

        # Verify it's gone
        r = await client.get("/api/agents", headers=_auth_headers())
        assert len(r.json()) == 0


@pytest.mark.asyncio
async def test_delete_agent_not_found(setup_server):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.delete("/api/agents/ghost", headers=_auth_headers())
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_run_missing_prompt(setup_server):
    archive = _make_archive({"agent.py": "pass"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        await client.post(
            "/api/agents",
            data={
                "name": "runner",
                "source_filename": "agent.py",
                "function_name": "runner",
                "config_json": "{}",
            },
            files={"archive": ("a.tar.gz", archive, "application/gzip")},
            headers=_auth_headers(),
        )

        r = await client.post(
            "/api/agents/runner/runs",
            json={},
            headers=_auth_headers(),
        )
        assert r.status_code == 400


@pytest.mark.asyncio
async def test_create_run_agent_not_found(setup_server):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/api/agents/nonexistent/runs",
            json={"prompt": "hello"},
            headers=_auth_headers(),
        )
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_auth_required(setup_server):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.get("/api/agents")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_auth_invalid_key(setup_server):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.get(
            "/api/agents",
            headers={"Authorization": "Bearer ns_wrong"},
        )
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_deploy_invalid_config_json(setup_server):
    archive = _make_archive({"agent.py": "pass"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/api/agents",
            data={
                "name": "bad_config",
                "source_filename": "agent.py",
                "function_name": "bad_config",
                "config_json": "not-json",
            },
            files={"archive": ("a.tar.gz", archive, "application/gzip")},
            headers=_auth_headers(),
        )
        assert r.status_code == 400
