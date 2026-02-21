"""nightshift agents — list and manage deployed agents."""

from __future__ import annotations

import click
import httpx

from nightshift.cli.config import get_auth_headers, get_url


@click.group(invoke_without_command=True)
@click.pass_context
def agents(ctx) -> None:
    """List deployed agents. Use 'agents rm' to delete one."""
    if ctx.invoked_subcommand is not None:
        return

    url = get_url()
    headers = get_auth_headers()

    try:
        r = httpx.get(f"{url}/api/agents", headers=headers, timeout=30)
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise click.ClickException(f"{e.response.status_code}: {e.response.text}")
    except httpx.HTTPError as e:
        raise click.ClickException(str(e))

    agent_list = r.json()
    if not agent_list:
        click.echo("No agents deployed.")
        return

    # Table format
    click.echo(f"{'NAME':<20} {'SOURCE':<25} {'UPDATED':<25}")
    click.echo("-" * 70)
    for a in agent_list:
        click.echo(f"{a['name']:<20} {a['source_filename']:<25} {a['updated_at']:<25}")


@agents.command()
@click.argument("name")
def rm(name: str) -> None:
    """Delete a deployed agent."""
    url = get_url()
    headers = get_auth_headers()

    try:
        r = httpx.delete(f"{url}/api/agents/{name}", headers=headers, timeout=30)
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise click.ClickException(f"{e.response.status_code}: {e.response.text}")
    except httpx.HTTPError as e:
        raise click.ClickException(str(e))

    click.echo(f"Deleted agent: {name}")
