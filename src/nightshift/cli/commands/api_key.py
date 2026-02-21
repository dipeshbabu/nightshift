"""nightshift api-key — generate and manage API keys via the platform server."""

from __future__ import annotations

import click
import httpx

from nightshift.cli.config import get_auth_headers, get_url


@click.group("api-key")
def api_key() -> None:
    """Generate and manage API keys."""
    pass


@api_key.command()
@click.option("--tenant", default=None, help="Tenant ID for the new key (defaults to your tenant)")
@click.option("--label", default="", help="Human-readable label for the key")
def generate(tenant: str | None, label: str) -> None:
    """Generate a new API key and print it.

    The raw key is only shown once — store it somewhere safe.
    """
    url = get_url()
    headers = get_auth_headers()

    body: dict = {"label": label}
    if tenant is not None:
        body["tenant"] = tenant

    resp = httpx.post(f"{url}/api/api-keys", json=body, headers=headers)
    if resp.status_code != 200:
        raise click.ClickException(f"{resp.status_code}: {resp.text}")

    data = resp.json()
    click.echo(data["key"])


@api_key.command("list")
def list_keys() -> None:
    """List API keys for your tenant."""
    url = get_url()
    headers = get_auth_headers()

    resp = httpx.get(f"{url}/api/api-keys", headers=headers)
    if resp.status_code != 200:
        raise click.ClickException(f"{resp.status_code}: {resp.text}")

    keys = resp.json()
    if not keys:
        click.echo("No API keys found.")
        return

    click.echo(f"{'HASH PREFIX':<16} {'TENANT':<16} {'LABEL':<20} {'CREATED'}")
    click.echo("-" * 76)
    for k in keys:
        click.echo(f"{k['hash_prefix']}...  {k['tenant']:<16} {k['label']:<20} {k['created_at']}")


@api_key.command()
@click.argument("hash_prefix")
def revoke(hash_prefix: str) -> None:
    """Revoke an API key by its hash prefix (from 'api-key list')."""
    url = get_url()
    headers = get_auth_headers()

    resp = httpx.delete(f"{url}/api/api-keys/{hash_prefix}", headers=headers)
    if resp.status_code != 200:
        raise click.ClickException(f"{resp.status_code}: {resp.text}")

    data = resp.json()
    click.echo(f"Revoked key {data['hash_prefix']}...")
