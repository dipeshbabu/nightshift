"""Package agent source code for injection into a Firecracker VM."""

from __future__ import annotations

import json
import os
import shutil
import tempfile


def _find_pyproject(start_path: str) -> str | None:
    """Walk up from start_path to find the nearest pyproject.toml."""
    directory = os.path.dirname(os.path.abspath(start_path))
    while True:
        candidate = os.path.join(directory, "pyproject.toml")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def package_agent(
    module_path: str,
    function_name: str,
    prompt: str,
) -> str:
    """Package an agent's source file and a manifest for VM injection.

    Creates a temp directory containing:
    - The agent's source file (copied)
    - manifest.json
    - pyproject.toml (auto-detected from agent's project, if found)
    - uv.lock (if present alongside pyproject.toml)

    Returns the path to the temp directory.
    """
    pkg_dir = tempfile.mkdtemp(prefix="nightshift-pkg-")

    # Copy the agent source file
    source_filename = os.path.basename(module_path)
    shutil.copy2(module_path, os.path.join(pkg_dir, source_filename))

    # Auto-detect and copy pyproject.toml + uv.lock
    pyproject_path = _find_pyproject(module_path)
    has_pyproject = False
    if pyproject_path:
        shutil.copy2(pyproject_path, os.path.join(pkg_dir, "pyproject.toml"))
        has_pyproject = True
        project_dir = os.path.dirname(pyproject_path)
        lock_path = os.path.join(project_dir, "uv.lock")
        if os.path.isfile(lock_path):
            shutil.copy2(lock_path, os.path.join(pkg_dir, "uv.lock"))

    # Write manifest
    manifest = {
        "module": os.path.splitext(source_filename)[0],
        "function": function_name,
        "prompt": prompt,
        "has_pyproject": has_pyproject,
    }
    with open(os.path.join(pkg_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)

    return pkg_dir


def cleanup_package(pkg_dir: str) -> None:
    """Remove a package directory created by package_agent."""
    shutil.rmtree(pkg_dir, ignore_errors=True)
