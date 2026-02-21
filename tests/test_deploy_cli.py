"""Tests for the deploy CLI command — workspace resolution, discovery, and upload."""

from __future__ import annotations

import io
import json
import os
import tarfile
from unittest.mock import MagicMock, patch

import click
import pytest
from click.testing import CliRunner

from nightshift.cli.commands.deploy import (
    _discover_agents,
    _make_archive,
    _resolve_workspace,
    deploy,
)


# ── _resolve_workspace ────────────────────────────────────────


class TestResolveWorkspace:
    def test_empty_string_returns_empty(self):
        assert _resolve_workspace("", "/some/dir") == ""

    def test_relative_path_resolved_against_file_dir(self, tmp_path):
        ws = tmp_path / "my-workspace"
        ws.mkdir()
        result = _resolve_workspace("./my-workspace", str(tmp_path))
        assert result == str(ws)

    def test_relative_path_without_dot_prefix(self, tmp_path):
        ws = tmp_path / "data"
        ws.mkdir()
        result = _resolve_workspace("data", str(tmp_path))
        assert result == str(ws)

    def test_parent_relative_path(self, tmp_path):
        child = tmp_path / "sub"
        child.mkdir()
        result = _resolve_workspace("../ws", str(child))
        assert result == str(tmp_path / "ws")

    def test_absolute_path_returned_as_is(self):
        result = _resolve_workspace("/absolute/workspace", "/ignored")
        assert result == "/absolute/workspace"

    def test_trailing_slash_normalised(self, tmp_path):
        result = _resolve_workspace("./ws/", str(tmp_path))
        # normpath strips trailing slash
        assert not result.endswith("/")
        assert result == str(tmp_path / "ws")


# ── _discover_agents ──────────────────────────────────────────


def _write_agent_file(path, workspace: str = "") -> str:
    """Write a minimal agent file and return its path."""
    ws_arg = f'"{workspace}"' if workspace else '""'
    path.write_text(
        f"""\
from nightshift import NightshiftApp, AgentConfig

app = NightshiftApp()

@app.agent(AgentConfig(workspace={ws_arg}))
async def test_agent(prompt: str):
    yield "ok"
"""
    )
    return str(path)


class TestDiscoverAgents:
    def test_discovers_agent_without_workspace(self, tmp_path):
        agent_file = _write_agent_file(tmp_path / "agent.py")
        agents = _discover_agents(agent_file)

        assert "test_agent" in agents
        info = agents["test_agent"]
        assert info["function_name"] == "test_agent"
        assert info["workspace"] == ""
        assert info["config"]["workspace"] == ""

    def test_discovers_agent_with_workspace(self, tmp_path):
        ws = tmp_path / "my-ws"
        ws.mkdir()
        (ws / "file.txt").write_text("data")

        agent_file = _write_agent_file(tmp_path / "agent.py", workspace="./my-ws")
        agents = _discover_agents(agent_file)

        info = agents["test_agent"]
        assert info["workspace"] == str(ws)
        # Original config keeps the raw value
        assert info["config"]["workspace"] == "./my-ws"

    def test_missing_workspace_dir_raises(self, tmp_path):
        agent_file = _write_agent_file(
            tmp_path / "agent.py", workspace="./nonexistent"
        )
        with pytest.raises(click.ClickException, match="does not exist"):
            _discover_agents(agent_file)

    def test_workspace_resolved_relative_to_agent_file(self, tmp_path):
        """Workspace path is relative to the agent file, not cwd."""
        subdir = tmp_path / "agents"
        subdir.mkdir()
        ws = tmp_path / "agents" / "ws"
        ws.mkdir()

        agent_file = _write_agent_file(subdir / "agent.py", workspace="./ws")
        agents = _discover_agents(agent_file)

        assert agents["test_agent"]["workspace"] == str(ws)


# ── deploy() command — integration with httpx mock ────────────


def _extract_tar_gz(data: bytes) -> dict[str, str]:
    """Extract a tar.gz archive from bytes and return {filename: content}."""
    result: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            if member.isfile():
                f = tar.extractfile(member)
                if f:
                    result[member.name] = f.read().decode()
    return result


class TestDeployCommand:
    """Test the deploy click command end-to-end with httpx mocked."""

    def _setup_project(self, tmp_path, *, workspace: bool = False):
        """Create a minimal project directory with agent file and optional workspace."""
        # pyproject.toml makes tmp_path the project root
        (tmp_path / "pyproject.toml").write_text('[project]\nname = "test"\n')
        (tmp_path / "helpers.py").write_text("# helper module\n")

        ws_arg = '"./test-workspace/"' if workspace else '""'
        (tmp_path / "agent.py").write_text(
            f"""\
from nightshift import NightshiftApp, AgentConfig

app = NightshiftApp()

@app.agent(AgentConfig(workspace={ws_arg}))
async def my_agent(prompt: str):
    yield "hello"
"""
        )

        if workspace:
            ws_dir = tmp_path / "test-workspace"
            ws_dir.mkdir()
            (ws_dir / "data.txt").write_text("workspace file")
            (ws_dir / "subdir").mkdir()
            (ws_dir / "subdir" / "nested.txt").write_text("nested")

        return tmp_path / "agent.py"

    def test_deploy_with_workspace_uploads_both_archives(self, tmp_path):
        agent_file = self._setup_project(tmp_path, workspace=True)

        captured_calls: list[dict] = []

        def mock_post(url, *, data, files, headers, timeout):
            captured_calls.append({"url": url, "data": data, "files": files})
            resp = MagicMock()
            resp.json.return_value = {"id": "abc-123", "name": "my_agent", "status": "deployed"}
            resp.raise_for_status = MagicMock()
            return resp

        runner = CliRunner()
        with patch("nightshift.cli.commands.deploy.httpx.post", side_effect=mock_post), \
             patch("nightshift.cli.commands.deploy.get_url", return_value="http://fake"), \
             patch("nightshift.cli.commands.deploy.get_auth_headers", return_value={"Authorization": "Bearer test"}):
            result = runner.invoke(deploy, [str(agent_file)])

        assert result.exit_code == 0, result.output
        assert "Packaging workspace" in result.output
        assert "deployed" in result.output

        # Verify the POST was made with both archives
        assert len(captured_calls) == 1
        call = captured_calls[0]
        assert "archive" in call["files"]
        assert "workspace_archive" in call["files"]

        # config_json should have __uploaded__ sentinel
        config = json.loads(call["data"]["config_json"])
        assert config["workspace"] == "__uploaded__"

        # Verify workspace archive contents
        ws_archive_bytes = call["files"]["workspace_archive"][1]
        ws_files = _extract_tar_gz(ws_archive_bytes)
        assert "data.txt" in ws_files
        assert ws_files["data.txt"] == "workspace file"
        assert os.path.join("subdir", "nested.txt") in ws_files

    def test_deploy_without_workspace_sends_only_source_archive(self, tmp_path):
        agent_file = self._setup_project(tmp_path, workspace=False)

        captured_calls: list[dict] = []

        def mock_post(url, *, data, files, headers, timeout):
            captured_calls.append({"url": url, "data": data, "files": files})
            resp = MagicMock()
            resp.json.return_value = {"id": "abc-123", "name": "my_agent", "status": "deployed"}
            resp.raise_for_status = MagicMock()
            return resp

        runner = CliRunner()
        with patch("nightshift.cli.commands.deploy.httpx.post", side_effect=mock_post), \
             patch("nightshift.cli.commands.deploy.get_url", return_value="http://fake"), \
             patch("nightshift.cli.commands.deploy.get_auth_headers", return_value={"Authorization": "Bearer test"}):
            result = runner.invoke(deploy, [str(agent_file)])

        assert result.exit_code == 0, result.output
        assert "Packaging workspace" not in result.output

        call = captured_calls[0]
        assert "archive" in call["files"]
        assert "workspace_archive" not in call["files"]

        # config_json should keep the original empty workspace
        config = json.loads(call["data"]["config_json"])
        assert config["workspace"] == ""

    def test_deploy_workspace_archive_excludes_dotfiles(self, tmp_path):
        """Workspace archive should respect EXCLUDE_PATTERNS (e.g. __pycache__)."""
        agent_file = self._setup_project(tmp_path, workspace=True)

        # Add excluded content to workspace
        ws_dir = tmp_path / "test-workspace"
        pycache = ws_dir / "__pycache__"
        pycache.mkdir()
        (pycache / "mod.cpython-313.pyc").write_text("bytecode")
        (ws_dir / "keep.py").write_text("keep me")

        captured_calls: list[dict] = []

        def mock_post(url, *, data, files, headers, timeout):
            captured_calls.append({"files": files})
            resp = MagicMock()
            resp.json.return_value = {"id": "x", "name": "my_agent", "status": "deployed"}
            resp.raise_for_status = MagicMock()
            return resp

        runner = CliRunner()
        with patch("nightshift.cli.commands.deploy.httpx.post", side_effect=mock_post), \
             patch("nightshift.cli.commands.deploy.get_url", return_value="http://fake"), \
             patch("nightshift.cli.commands.deploy.get_auth_headers", return_value={"Authorization": "Bearer test"}):
            result = runner.invoke(deploy, [str(agent_file)])

        assert result.exit_code == 0, result.output

        ws_files = _extract_tar_gz(captured_calls[0]["files"]["workspace_archive"][1])
        assert "keep.py" in ws_files
        # __pycache__ content should be excluded
        for name in ws_files:
            assert "__pycache__" not in name

    def test_deploy_nonexistent_workspace_fails(self, tmp_path):
        """If the workspace directory doesn't exist, deploy should fail."""
        (tmp_path / "pyproject.toml").write_text('[project]\nname = "t"\n')
        (tmp_path / "agent.py").write_text(
            """\
from nightshift import NightshiftApp, AgentConfig

app = NightshiftApp()

@app.agent(AgentConfig(workspace="./missing-dir/"))
async def my_agent(prompt: str):
    yield "hello"
"""
        )

        runner = CliRunner()
        with patch("nightshift.cli.commands.deploy.get_url", return_value="http://fake"), \
             patch("nightshift.cli.commands.deploy.get_auth_headers", return_value={"Authorization": "Bearer test"}):
            result = runner.invoke(deploy, [str(tmp_path / "agent.py")])

        assert result.exit_code != 0
        assert "does not exist" in result.output
