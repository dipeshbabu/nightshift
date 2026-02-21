"""Tests for the SDK module (NightshiftApp, AgentConfig)."""

from nightshift import NightshiftApp, AgentConfig
from nightshift.sdk.app import RegisteredAgent


def test_agent_config_defaults():
    config = AgentConfig()
    assert config.workspace == ""
    assert config.vcpu_count == 2
    assert config.mem_size_mib == 2048
    assert config.timeout_seconds == 1800
    assert config.forward_env == []
    assert config.env == {}


def test_agent_config_custom():
    config = AgentConfig(
        workspace="/home/user/my-project",
        vcpu_count=4,
        mem_size_mib=8192,
        timeout_seconds=3600,
        forward_env=["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        env={"CUSTOM": "value"},
    )
    assert config.workspace == "/home/user/my-project"
    assert config.vcpu_count == 4
    assert config.mem_size_mib == 8192
    assert config.timeout_seconds == 3600
    assert "OPENAI_API_KEY" in config.forward_env
    assert config.env["CUSTOM"] == "value"


def test_nightshift_app_register_agent():
    app = NightshiftApp()

    @app.agent(AgentConfig(vcpu_count=4))
    async def my_agent(prompt: str):
        yield {"type": "result"}

    assert "my_agent" in app._agents
    agent = app._agents["my_agent"]
    assert isinstance(agent, RegisteredAgent)
    assert agent.name == "my_agent"
    assert agent.config.vcpu_count == 4
    assert agent.fn is my_agent


def test_nightshift_app_register_agent_default_config():
    app = NightshiftApp()

    @app.agent()
    async def simple_agent(prompt: str):
        yield {"type": "result"}

    assert "simple_agent" in app._agents
    assert app._agents["simple_agent"].config.vcpu_count == 2


def test_nightshift_app_register_agent_custom_name():
    app = NightshiftApp()

    @app.agent(AgentConfig(), name="custom_name")
    async def my_agent(prompt: str):
        yield {"type": "result"}

    assert "custom_name" in app._agents
    assert "my_agent" not in app._agents


def test_nightshift_app_multiple_agents():
    app = NightshiftApp()

    @app.agent(AgentConfig())
    async def agent_a(prompt: str):
        yield {"type": "result"}

    @app.agent(AgentConfig(vcpu_count=8))
    async def agent_b(prompt: str):
        yield {"type": "result"}

    assert len(app._agents) == 2
    assert "agent_a" in app._agents
    assert "agent_b" in app._agents
    assert app._agents["agent_b"].config.vcpu_count == 8


def test_nightshift_app_module_path():
    app = NightshiftApp()

    @app.agent(AgentConfig())
    async def test_agent(prompt: str):
        yield {"type": "result"}

    assert app._agents["test_agent"].module_path.endswith(".py")


def test_top_level_imports():
    """NightshiftApp and AgentConfig are importable from nightshift."""
    from nightshift import NightshiftApp, AgentConfig

    assert NightshiftApp is not None
    assert AgentConfig is not None
