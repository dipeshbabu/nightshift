"""rootfs overlay preparation for Firecracker VMs.

Creates a copy-on-write overlay of the base rootfs for each VM,
copies the workspace into it, and writes auth/env files.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile

logger = logging.getLogger(__name__)


async def _run(cmd: str, **kwargs) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_shell(
        cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **kwargs,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode or 0, stdout.decode().strip(), stderr.decode().strip()


def _inject_files(
    mount_point: str,
    workspace_path: str,
    agent_pkg_path: str,
    env_vars: dict[str, str],
) -> None:
    """Synchronous file injection into a mounted overlay (runs in a thread)."""
    # Copy workspace into /workspace
    ws_dest = os.path.join(mount_point, "workspace")
    if os.path.exists(ws_dest):
        shutil.rmtree(ws_dest)
    shutil.copytree(workspace_path, ws_dest, symlinks=True)

    # Copy agent package into /opt/nightshift/agent_pkg
    if agent_pkg_path:
        pkg_dest = os.path.join(mount_point, "opt", "nightshift", "agent_pkg")
        if os.path.exists(pkg_dest):
            shutil.rmtree(pkg_dest)
        shutil.copytree(agent_pkg_path, pkg_dest, symlinks=True)

    # Write env vars
    env_dir = os.path.join(mount_point, "etc", "nightshift")
    os.makedirs(env_dir, exist_ok=True)
    env_file = os.path.join(env_dir, "env")
    with open(env_file, "w") as f:
        for k, v in env_vars.items():
            f.write(f"{k}={v}\n")

    # DNS — replace systemd-resolved stub with real resolvers
    resolv_dest = os.path.join(mount_point, "etc", "resolv.conf")
    if os.path.islink(resolv_dest):
        os.remove(resolv_dest)
    with open(resolv_dest, "w") as f:
        f.write("nameserver 8.8.8.8\nnameserver 1.1.1.1\n")


async def create_overlay(
    base_rootfs_path: str,
    vm_id: str,
    workspace_path: str,
    env_vars: dict[str, str],
    overlay_dir: str | None = None,
    agent_pkg_path: str = "",
) -> str:
    """Create a CoW overlay rootfs for a VM.

    1. Create a sparse copy of the base rootfs
    2. Mount the overlay
    3. Copy workspace into /workspace
    4. Copy agent package into /opt/nightshift/agent_pkg (if provided)
    5. Write env vars to /etc/nightshift/env
    6. Unmount and return overlay path

    Returns the path to the overlay rootfs image.
    """
    if overlay_dir is None:
        overlay_dir = tempfile.mkdtemp(prefix="nightshift-vm-")

    overlay_path = os.path.join(overlay_dir, f"{vm_id}.ext4")

    # Create sparse copy using cp --sparse=always (async subprocess)
    code, _, stderr = await _run(f"cp --sparse=always {base_rootfs_path} {overlay_path}")
    if code != 0:
        # Fallback: regular copy in a thread (macOS doesn't support --sparse)
        logger.warning("cp --sparse failed (%s), falling back to shutil.copy2 in thread", stderr)
        await asyncio.to_thread(shutil.copy2, base_rootfs_path, overlay_path)

    # Mount the overlay to inject files
    mount_point = os.path.join(overlay_dir, f"mnt-{vm_id}")
    os.makedirs(mount_point, exist_ok=True)

    code, _, stderr = await _run(f"mount -o loop {overlay_path} {mount_point}")
    if code != 0:
        raise RuntimeError(f"Failed to mount overlay: {stderr}")

    try:
        # Run all file injection in a thread to avoid blocking the event loop
        await asyncio.to_thread(
            _inject_files, mount_point, workspace_path, agent_pkg_path, env_vars
        )
    finally:
        await _run(f"umount {mount_point}")
        os.rmdir(mount_point)

    return overlay_path


async def destroy_overlay(overlay_path: str) -> None:
    """Remove an overlay rootfs and its parent directory."""
    overlay_dir = os.path.dirname(overlay_path)
    if os.path.exists(overlay_path):
        os.remove(overlay_path)
    if os.path.isdir(overlay_dir) and not os.listdir(overlay_dir):
        os.rmdir(overlay_dir)


async def copy_workspace_out(
    overlay_path: str,
    vm_id: str,
    dest_path: str,
) -> None:
    """Mount overlay and copy /workspace contents to dest_path."""
    mount_point = os.path.join(os.path.dirname(overlay_path), f"mnt-out-{vm_id}")
    os.makedirs(mount_point, exist_ok=True)

    code, _, stderr = await _run(f"mount -o loop,ro {overlay_path} {mount_point}")
    if code != 0:
        raise RuntimeError(f"Failed to mount overlay for copy-out: {stderr}")

    try:
        ws_src = os.path.join(mount_point, "workspace")
        if os.path.isdir(ws_src):
            # Sync workspace contents back
            code, _, stderr = await _run(f"rsync -a --delete {ws_src}/ {dest_path}/")
            if code != 0:
                raise RuntimeError(f"Failed to copy workspace out: {stderr}")
    finally:
        await _run(f"umount {mount_point}")
        os.rmdir(mount_point)
