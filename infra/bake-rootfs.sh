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
echo "==> Installing init script"
# /sbin/init is a symlink to ../lib/systemd/systemd — remove it first
# so we don't overwrite the systemd binary.
rm -f "$MOUNT_DIR/sbin/init"
cat > "$MOUNT_DIR/sbin/init" << 'INIT'
#!/bin/sh
#
# Nightshift VM init — PID 1 inside the Firecracker microVM.
#

# Mount essential filesystems (ignore errors if kernel already mounted them)
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sysfs /sys 2>/dev/null
mount -t devtmpfs devtmpfs /dev 2>/dev/null
mount -t tmpfs tmpfs /tmp 2>/dev/null
mount -t tmpfs tmpfs /run 2>/dev/null

# Configure network from kernel command line
# ip=GUEST::GATEWAY:MASK::eth0:off
GUEST_IP=$(cat /proc/cmdline | tr ' ' '\n' | grep '^ip=' | cut -d= -f2 | cut -d: -f1)
GATEWAY=$(cat /proc/cmdline | tr ' ' '\n' | grep '^ip=' | cut -d= -f2 | cut -d: -f3)
MASK=$(cat /proc/cmdline | tr ' ' '\n' | grep '^ip=' | cut -d= -f2 | cut -d: -f4)

if [ -n "$GUEST_IP" ]; then
    ip addr add "${GUEST_IP}/${MASK}" dev eth0 2>/dev/null
    ip link set eth0 up 2>/dev/null
    ip route add default via "$GATEWAY" 2>/dev/null
fi

# DNS
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf

# Load environment
if [ -f /etc/nightshift/env ]; then
    set -a
    . /etc/nightshift/env
    set +a
fi

export PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PYTHONPATH="/opt"

# Start the agent
cd /workspace
exec python3 -m nightshift.agent
INIT
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
