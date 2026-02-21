"""nightshift login — store platform credentials."""

from __future__ import annotations

import click
import httpx

from nightshift.cli.config import save_config


@click.command()
@click.option("--url", required=True, help="Platform server URL (e.g. http://localhost:3000)")
@click.option("--api-key", required=True, help="API key (ns_...)")
def login(url: str, api_key: str) -> None:
    """Authenticate with a Nightshift platform server."""
    # Strip trailing slash
    url = url.rstrip("/")

    # Verify the connection
    try:
        r = httpx.get(f"{url}/health", timeout=10)
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise click.ClickException(f"Cannot reach server at {url}: {e}")

    save_config({"url": url, "api_key": api_key})
    click.echo(f"Logged in to {url}")
