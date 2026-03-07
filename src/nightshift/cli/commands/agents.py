"""nightshift agents — list and manage deployed agents."""

from __future__ import annotations

import click
import httpx

from nightshift.cli.config import get_auth_headers, get_url


@click.group(invoke_without_command=True)
@click.option("-v", "--verbose", is_flag=True, help="Show invoke/workspace URLs.")
@click.pass_context
def agents(ctx, verbose: bool) -> None:
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

    if verbose:
        for i, a in enumerate(agent_list):
            if i > 0:
                click.echo()
            click.echo(a["name"])
            click.echo(f"  Source:    {a['source_filename']}")
            click.echo(f"  Invoke:    {a['invoke_url']}")
            if a.get("workspace_url"):
                click.echo(f"  Workspace: {a['workspace_url']}")
            click.echo(f"  Updated:   {a['updated_at']}")
    else:
        click.echo(f"{'NAME':<20} {'SOURCE':<25} {'UPDATED':<25}")
        click.echo("-" * 70)
        for a in agent_list:
            click.echo(f"{a['name']:<20} {a['source_filename']:<25} {a['updated_at']:<25}")


@agents.command()
@click.argument("name")
def info(name: str) -> None:
    """Show details for a single agent."""
    url = get_url()
    headers = get_auth_headers()

    try:
        r = httpx.get(f"{url}/api/agents/{name}", headers=headers, timeout=30)
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise click.ClickException(f"{e.response.status_code}: {e.response.text}")
    except httpx.HTTPError as e:
        raise click.ClickException(str(e))

    a = r.json()
    click.echo(a["name"])
    click.echo(f"  ID:        {a['id']}")
    click.echo(f"  Source:    {a['source_filename']}")
    click.echo(f"  Stateful:  {a['stateful']}")
    click.echo(f"  Invoke:    {a['invoke_url']}")
    if a.get("workspace_url"):
        click.echo(f"  Workspace: {a['workspace_url']}")

    cfg = a.get("config", {})
    if cfg:
        click.echo(f"  vCPU:      {cfg.get('vcpu_count')}")
        click.echo(f"  Memory:    {cfg.get('mem_size_mib')} MiB")
        click.echo(f"  Timeout:   {cfg.get('timeout_seconds')}s")

    click.echo(f"  Created:   {a['created_at']}")
    click.echo(f"  Updated:   {a['updated_at']}")


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
