"""Tests for configuration."""

from nightshift.config import NightshiftConfig


def test_config_defaults():
    config = NightshiftConfig(workspace="/tmp/test")
    assert config.port == 3000
    assert config.vm_timeout_seconds == 1800
    assert config.db_path == "/opt/nightshift/nightshift.db"
    assert config.agents_storage_dir == "/opt/nightshift/agents"


def test_config_from_env(monkeypatch):
    monkeypatch.setenv("NIGHTSHIFT_WORKSPACE", "/tmp/ws")
    monkeypatch.setenv("NIGHTSHIFT_PORT", "4000")
    monkeypatch.setenv("NIGHTSHIFT_DB_PATH", "/tmp/test.db")
    monkeypatch.setenv("NIGHTSHIFT_AGENTS_DIR", "/tmp/agents")

    config = NightshiftConfig.from_env()
    assert config.workspace == "/tmp/ws"
    assert config.port == 4000
    assert config.db_path == "/tmp/test.db"
    assert config.agents_storage_dir == "/tmp/agents"


def test_env_vars_for_vm():
    config = NightshiftConfig(workspace="/tmp/test")
    env = config.env_vars_for_vm()

    # ANTHROPIC_API_KEY is per-user, passed at runtime via CLI — not a platform env var
    assert "ANTHROPIC_API_KEY" not in env
    assert env["NIGHTSHIFT_WORKSPACE"] == "/workspace"
