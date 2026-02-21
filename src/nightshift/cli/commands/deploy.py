"""nightshift deploy — deploy an agent to the platform."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tarfile

import click
import httpx

from nightshift.cli.config import get_auth_headers, get_url

# Patterns to exclude from the archive
EXCLUDE_PATTERNS = {".git", "__pycache__", ".venv", ".env", "*.pyc", "node_modules", ".ruff_cache"}


def _should_exclude(path: str) -> bool:
    """Check if a path should be excluded from the archive."""
    parts = path.split(os.sep)
    for part in parts:
        if part in EXCLUDE_PATTERNS:
            return True
        for pattern in EXCLUDE_PATTERNS:
            if pattern.startswith("*") and part.endswith(pattern[1:]):
                return True
    return False


def _make_archive(project_dir: str) -> bytes:
    """Create a tar.gz archive of the project directory."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for root, dirs, files in os.walk(project_dir):
            # Filter out excluded directories in-place
            dirs[:] = [d for d in dirs if not _should_exclude(d)]

            for f in files:
                if _should_exclude(f):
                    continue
                full_path = os.path.join(root, f)
                arcname = os.path.relpath(full_path, project_dir)
                tar.add(full_path, arcname=arcname)
    buf.seek(0)
    return buf.read()


def _resolve_workspace(workspace_raw: str, file_dir: str) -> str:
    """Resolve a workspace path relative to the agent file's directory.

    Returns an absolute path if *workspace_raw* is non-empty, or "" otherwise.
    """
    if not workspace_raw:
        return ""
    path = os.path.normpath(os.path.join(file_dir, workspace_raw))
    return os.path.abspath(path)


def _discover_agents(file_path: str) -> dict:
    """Import a file and find the NightshiftApp instance to discover agents."""
    file_path = os.path.abspath(file_path)
    file_dir = os.path.dirname(file_path)
    module_name = os.path.splitext(os.path.basename(file_path))[0]

    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise click.ClickException(f"Cannot import {file_path}")

    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)

    # Find the NightshiftApp instance
    from nightshift.sdk.app import NightshiftApp

    app = None
    for attr_name in dir(mod):
        obj = getattr(mod, attr_name)
        if isinstance(obj, NightshiftApp):
            app = obj
            break

    if app is None:
        raise click.ClickException(f"No NightshiftApp instance found in {file_path}")

    if not app._agents:
        raise click.ClickException(f"No agents registered in {file_path}")

    agents: dict = {}
    for name, agent in app._agents.items():
        workspace = _resolve_workspace(agent.config.workspace, file_dir)
        if workspace and not os.path.isdir(workspace):
            raise click.ClickException(
                f"Agent '{name}': workspace directory does not exist: {workspace}"
            )
        agents[name] = {
            "function_name": agent.fn.__name__,
            "workspace": workspace,
            "config": {
                "workspace": agent.config.workspace,
                "vcpu_count": agent.config.vcpu_count,
                "mem_size_mib": agent.config.mem_size_mib,
                "timeout_seconds": agent.config.timeout_seconds,
                "forward_env": agent.config.forward_env,
                "env": agent.config.env,
                "max_concurrent_vms": agent.config.max_concurrent_vms,
                "stateful": agent.config.stateful,
            },
        }
    return agents


@click.command()
@click.argument("file", type=click.Path(exists=True))
def deploy(file: str) -> None:
    """Deploy agents from a Python file to the platform.

    FILE is the path to a Python file containing a NightshiftApp with
    registered agents (e.g. examples/basic_agent.py).
    """
    url = get_url()
    headers = get_auth_headers()

    click.echo(f"Discovering agents in {file}...")
    agents = _discover_agents(file)

    # Determine project directory (where pyproject.toml is, or the file's dir)
    file_dir = os.path.dirname(os.path.abspath(file))
    project_dir = file_dir

    # Walk up to find pyproject.toml
    check = file_dir
    while check != os.path.dirname(check):
        if os.path.exists(os.path.join(check, "pyproject.toml")):
            project_dir = check
            break
        check = os.path.dirname(check)

    source_filename = os.path.relpath(os.path.abspath(file), project_dir)

    click.echo(f"Packaging {project_dir}...")
    archive = _make_archive(project_dir)
    click.echo(f"Archive size: {len(archive)} bytes")

    for name, info in agents.items():
        click.echo(f"Deploying {name}...")

        config = dict(info["config"])
        workspace_path = info["workspace"]

        upload_files: dict[str, tuple] = {
            "archive": ("archive.tar.gz", archive, "application/gzip"),
        }

        if workspace_path:
            click.echo(f"  Packaging workspace {workspace_path}...")
            ws_archive = _make_archive(workspace_path)
            click.echo(f"  Workspace archive size: {len(ws_archive)} bytes")
            upload_files["workspace_archive"] = (
                "workspace.tar.gz",
                ws_archive,
                "application/gzip",
            )
            config["workspace"] = "__uploaded__"

        try:
            r = httpx.post(
                f"{url}/api/agents",
                data={
                    "name": name,
                    "source_filename": source_filename,
                    "function_name": info["function_name"],
                    "config_json": json.dumps(config),
                },
                files=upload_files,
                headers=headers,
                timeout=120,
            )
            r.raise_for_status()
            data = r.json()
            click.echo(f"  {name}: {data['status']} (id: {data['id']})")
        except httpx.HTTPStatusError as e:
            click.echo(f"  {name}: FAILED — {e.response.status_code} {e.response.text}", err=True)
        except httpx.HTTPError as e:
            click.echo(f"  {name}: FAILED — {e}", err=True)

    click.echo("Done.")
