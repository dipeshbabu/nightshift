"""nightshift run — start an agent run and optionally follow events."""

from __future__ import annotations

import json
import os
import sys

import click
import httpx
from httpx_sse import connect_sse

from nightshift.cli.config import get_auth_headers, get_url
from nightshift.events import TERMINAL_EVENTS


@click.command()
@click.argument("agent_name")
@click.option("--prompt", "-p", required=True, help="Prompt to send to the agent")
@click.option("--follow", "-f", is_flag=True, help="Follow the event stream (like tail -f)")
def run(agent_name: str, prompt: str, follow: bool) -> None:
    """Start a run for an agent on the platform."""
    url = get_url()
    headers = get_auth_headers()

    # Forward ANTHROPIC_API_KEY from the local environment into the VM
    runtime_env: dict[str, str] = {}
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        runtime_env["ANTHROPIC_API_KEY"] = api_key
    else:
        click.echo("Warning: ANTHROPIC_API_KEY not set in local environment", err=True)

    try:
        r = httpx.post(
            f"{url}/api/agents/{agent_name}/runs",
            json={"prompt": prompt, "env": runtime_env},
            headers=headers,
            timeout=30,
        )
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise click.ClickException(f"{e.response.status_code}: {e.response.text}")
    except httpx.HTTPError as e:
        raise click.ClickException(str(e))

    data = r.json()
    run_id = data["id"]
    click.echo(f"Run started: {run_id}")

    if follow:
        _follow_events(url, headers, run_id)


def _follow_events(url: str, headers: dict, run_id: str) -> None:
    """Stream SSE events for a run to stdout."""
    try:
        with httpx.Client(timeout=None, headers=headers) as client:
            with connect_sse(client, "GET", f"{url}/api/runs/{run_id}/events") as sse:
                for event in sse.iter_sse():
                    if not event.data:
                        continue
                    try:
                        data = json.loads(event.data)
                    except json.JSONDecodeError:
                        continue

                    event_type = data.get("type", event.event)
                    _print_event(event_type, data)

                    if event_type in TERMINAL_EVENTS:
                        return
    except httpx.HTTPError as e:
        raise click.ClickException(f"Event stream error: {e}")


def _print_event(event_type: str, data: dict) -> None:
    """Pretty-print an SSE event to stdout."""
    if event_type == "nightshift.started":
        click.echo(f"[started] workspace={data.get('workspace', '')}")
    elif event_type == "nightshift.completed":
        click.echo("[completed]")
    elif event_type == "nightshift.error":
        click.echo(f"[error] {data.get('error', '')}", err=True)
    elif event_type == "nightshift.interrupted":
        click.echo(f"[interrupted] reason={data.get('reason', '')}")
    else:
        # Agent message — print the text content if available
        text = data.get("text", data.get("content", ""))
        if text:
            click.echo(text, nl=False)
            sys.stdout.flush()
        else:
            click.echo(json.dumps(data, indent=2))
