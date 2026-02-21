"""nightshift logs — stream events from a previous run."""

from __future__ import annotations

import json
import sys

import click
import httpx
from httpx_sse import connect_sse

from nightshift.cli.config import get_auth_headers, get_url
from nightshift.events import TERMINAL_EVENTS


@click.command()
@click.argument("run_id")
def logs(run_id: str) -> None:
    """Stream events from a run.

    RUN_ID is the UUID returned by 'nightshift run'.
    """
    url = get_url()
    headers = get_auth_headers()

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
    except httpx.HTTPStatusError as e:
        raise click.ClickException(f"{e.response.status_code}: {e.response.text}")
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
        text = data.get("text", data.get("content", ""))
        if text:
            click.echo(text, nl=False)
            sys.stdout.flush()
        else:
            click.echo(json.dumps(data, indent=2))
