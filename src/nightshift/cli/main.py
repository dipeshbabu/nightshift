"""Nightshift CLI — deploy and manage agents on the platform."""

from __future__ import annotations

import click

from nightshift.cli.commands.agents import agents
from nightshift.cli.commands.api_key import api_key
from nightshift.cli.commands.deploy import deploy
from nightshift.cli.commands.login import login
from nightshift.cli.commands.logs import logs
from nightshift.cli.commands.run import run


@click.group()
def cli() -> None:
    """Nightshift — autonomous agent orchestrator with Firecracker VMs."""
    pass


# Register subcommands
cli.add_command(login)
cli.add_command(deploy)
cli.add_command(run)
cli.add_command(logs)
cli.add_command(agents)
cli.add_command(api_key)


@cli.command()
@click.option("--host", default="0.0.0.0", help="Bind host")
@click.option("--port", default=3000, type=int, help="Bind port")
def serve(host: str, port: int) -> None:
    """Start the Nightshift platform server."""
    import asyncio

    from nightshift.server import start_server

    asyncio.run(start_server(host=host, port=port))
