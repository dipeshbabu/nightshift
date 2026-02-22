"""OpenAI agent — simple streaming assistant.

Demonstrates Nightshift with the OpenAI Agents SDK.
Uses forward_env to pass the API key from the server, or --env from the CLI.

Usage:
    nightshift deploy examples/oai_agent.py
    nightshift run oai_agent -p "hello" -f --env OPENAI_API_KEY=$OPENAI_API_KEY
"""

from agents import Agent, Runner
from nightshift import NightshiftApp, AgentConfig

app = NightshiftApp()


@app.agent(AgentConfig(workspace="", forward_env=["OPENAI_API_KEY"], max_concurrent_vms=3))
async def oai_agent(prompt: str):
    agent = Agent(name="Assistant", instructions="You are a helpful assistant")
    result = Runner.run_streamed(agent, prompt)
    async for event in result.stream_events():
        yield event
