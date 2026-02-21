"""Tests for the platform /api/* endpoints."""

import io
import json
import os
import tarfile

import pytest
from httpx import ASGITransport, AsyncClient

from nightshift.auth import hash_api_key
from nightshift.registry import AgentRegistry
from nightshift.server import app, _auth_dependency, _build_registered_agent
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


# ── Workspace upload tests ────────────────────────────────────


@pytest.mark.asyncio
async def test_deploy_with_workspace_archive(setup_server):
    """Deploy with a workspace archive — verify __workspace__/ dir and contents."""
    archive = _make_archive({"agent.py": "pass"})
    ws_archive = _make_archive({"data.txt": "hello", "subdir/nested.txt": "nested"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/api/agents",
            data={
                "name": "ws_agent",
                "source_filename": "agent.py",
                "function_name": "ws_agent",
                "config_json": json.dumps({"workspace": "__uploaded__"}),
            },
            files={
                "archive": ("archive.tar.gz", archive, "application/gzip"),
                "workspace_archive": ("workspace.tar.gz", ws_archive, "application/gzip"),
            },
            headers=_auth_headers(),
        )
        assert r.status_code == 200

        agent = await setup_server.get_agent(TEST_TENANT, "ws_agent")
        ws_dir = os.path.join(agent.storage_path, "__workspace__")
        assert os.path.isdir(ws_dir)
        assert os.path.isfile(os.path.join(ws_dir, "data.txt"))
        with open(os.path.join(ws_dir, "data.txt")) as f:
            assert f.read() == "hello"
        assert os.path.isfile(os.path.join(ws_dir, "subdir", "nested.txt"))


@pytest.mark.asyncio
async def test_deploy_without_workspace_archive(setup_server):
    """Deploy without a workspace archive — verify no __workspace__/ dir."""
    archive = _make_archive({"agent.py": "pass"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/api/agents",
            data={
                "name": "no_ws_agent",
                "source_filename": "agent.py",
                "function_name": "no_ws_agent",
                "config_json": json.dumps({"vcpu_count": 2}),
            },
            files={"archive": ("archive.tar.gz", archive, "application/gzip")},
            headers=_auth_headers(),
        )
        assert r.status_code == 200

        agent = await setup_server.get_agent(TEST_TENANT, "no_ws_agent")
        ws_dir = os.path.join(agent.storage_path, "__workspace__")
        assert not os.path.exists(ws_dir)


@pytest.mark.asyncio
async def test_redeploy_replaces_workspace(setup_server):
    """Re-deploy with a new workspace — verify old files are replaced."""
    archive = _make_archive({"agent.py": "pass"})
    ws_v1 = _make_archive({"old.txt": "old"})
    ws_v2 = _make_archive({"new.txt": "new"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        # Deploy v1
        await client.post(
            "/api/agents",
            data={
                "name": "ws_redeploy",
                "source_filename": "agent.py",
                "function_name": "ws_redeploy",
                "config_json": json.dumps({"workspace": "__uploaded__"}),
            },
            files={
                "archive": ("archive.tar.gz", archive, "application/gzip"),
                "workspace_archive": ("workspace.tar.gz", ws_v1, "application/gzip"),
            },
            headers=_auth_headers(),
        )

        agent = await setup_server.get_agent(TEST_TENANT, "ws_redeploy")
        ws_dir = os.path.join(agent.storage_path, "__workspace__")
        assert os.path.isfile(os.path.join(ws_dir, "old.txt"))

        # Deploy v2
        await client.post(
            "/api/agents",
            data={
                "name": "ws_redeploy",
                "source_filename": "agent.py",
                "function_name": "ws_redeploy",
                "config_json": json.dumps({"workspace": "__uploaded__"}),
            },
            files={
                "archive": ("archive.tar.gz", archive, "application/gzip"),
                "workspace_archive": ("workspace.tar.gz", ws_v2, "application/gzip"),
            },
            headers=_auth_headers(),
        )

        # Old file should be gone, new file should exist
        assert not os.path.exists(os.path.join(ws_dir, "old.txt"))
        assert os.path.isfile(os.path.join(ws_dir, "new.txt"))
        with open(os.path.join(ws_dir, "new.txt")) as f:
            assert f.read() == "new"


@pytest.mark.asyncio
async def test_build_registered_agent_resolves_uploaded_workspace(setup_server):
    """_build_registered_agent resolves '__uploaded__' to the __workspace__ path."""
    archive = _make_archive({"agent.py": "pass"})
    ws_archive = _make_archive({"file.txt": "content"})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        await client.post(
            "/api/agents",
            data={
                "name": "resolve_test",
                "source_filename": "agent.py",
                "function_name": "resolve_test",
                "config_json": json.dumps({"workspace": "__uploaded__"}),
            },
            files={
                "archive": ("archive.tar.gz", archive, "application/gzip"),
                "workspace_archive": ("workspace.tar.gz", ws_archive, "application/gzip"),
            },
            headers=_auth_headers(),
        )

    agent_record = await setup_server.get_agent(TEST_TENANT, "resolve_test")
    registered = _build_registered_agent(agent_record)
    expected = os.path.join(agent_record.storage_path, "__workspace__")
    assert registered.config.workspace == expected
