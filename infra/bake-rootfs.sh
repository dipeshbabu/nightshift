#!/bin/bash
#
# Bake the nightshift agent runtime into the base rootfs.
#
# Mounts the base rootfs image, copies the latest agent code and boot
# config, then unmounts. Run this on the server after deploying new code
# that changes any file the VM needs at boot time.
#
# What gets baked:
#   /sbin/init                     — minimal shell init (PID 1)
#   /opt/nightshift/agent/         — entry.py, __main__.py (agent runner)
#   /opt/nightshift/sdk/           — NightshiftApp, AgentConfig
#   /opt/nightshift/events.py      — event types
#   /opt/nightshift/protocol/      — packaging/event serialization
#
# What is NOT baked (injected per-VM via overlay):
#   /workspace/                    — user project files
#   /opt/nightshift/agent_pkg/     — user's agent code + manifest
#   /etc/nightshift/env            — environment variables
#
# Usage:
#   sudo ./infra/bake-rootfs.sh
#   sudo ./infra/bake-rootfs.sh /path/to/rootfs.ext4
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/src/nightshift"

ROOTFS="${1:-/opt/nightshift/rootfs.ext4}"

if [ ! -f "$ROOTFS" ]; then
    echo "Error: rootfs not found at $ROOTFS"
    exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (need mount)"
    exit 1
fi

MOUNT_DIR="$(mktemp -d)"
trap 'umount "$MOUNT_DIR" 2>/dev/null || true; rmdir "$MOUNT_DIR" 2>/dev/null || true' EXIT

echo "==> Mounting $ROOTFS"
mount -o loop "$ROOTFS" "$MOUNT_DIR"

# ── Agent runtime code ───────────────────────────────────────
echo "==> Copying agent runtime"
mkdir -p "$MOUNT_DIR/opt/nightshift"

rm -rf "$MOUNT_DIR/opt/nightshift/agent"
cp -r "$SRC_DIR/agent" "$MOUNT_DIR/opt/nightshift/agent"
find "$MOUNT_DIR/opt/nightshift/agent" -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

# Copy the SDK (NightshiftApp, AgentConfig) — user agent code imports these.
rm -rf "$MOUNT_DIR/opt/nightshift/sdk"
cp -r "$SRC_DIR/sdk" "$MOUNT_DIR/opt/nightshift/sdk"
find "$MOUNT_DIR/opt/nightshift/sdk" -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

# Copy the top-level __init__.py (re-exports NightshiftApp, AgentConfig).
cp "$SRC_DIR/__init__.py" "$MOUNT_DIR/opt/nightshift/__init__.py"

cp "$SRC_DIR/events.py" "$MOUNT_DIR/opt/nightshift/events.py"

rm -rf "$MOUNT_DIR/opt/nightshift/protocol"
cp -r "$SRC_DIR/protocol" "$MOUNT_DIR/opt/nightshift/protocol"
find "$MOUNT_DIR/opt/nightshift/protocol" -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

echo "    agent/         → entry.py, __init__.py"
echo "    events.py"
echo "    protocol/      → packaging.py, events.py"

# ── Init script ──────────────────────────────────────────────
# Replace systemd with a minimal shell init. Systemd is too heavy for
# Firecracker microVMs — it can panic or hang during boot. Our init
# sets up the essentials (filesystems, network, env) and starts the agent.
#
# The init script lives in rootfs/init (single source of truth).
echo "==> Installing init script"
# /sbin/init is a symlink to ../lib/systemd/systemd — remove it first
# so we don't overwrite the systemd binary.
rm -f "$MOUNT_DIR/sbin/init"
cp "$PROJECT_DIR/rootfs/init" "$MOUNT_DIR/sbin/init"
chmod +x "$MOUNT_DIR/sbin/init"

# ── Required directories ─────────────────────────────────────
mkdir -p "$MOUNT_DIR/workspace"
mkdir -p "$MOUNT_DIR/etc/nightshift"
mkdir -p "$MOUNT_DIR/opt/nightshift/agent_pkg"

echo "==> Unmounting"
umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"

echo "==> Done. Rootfs baked: $ROOTFS"
echo ""
echo "  Restart the server to pick up changes:"
echo "    sudo systemctl restart nightshift-serve"
