#!/bin/bash
#
# Build the base rootfs image for Nightshift Firecracker VMs.
#
# Produces an ext4 image with:
#   - Alpine Linux (minimal)
#   - Python 3.12+ (via uv)
#   - uv package manager
#   - Node.js (required by claude CLI)
#   - claude CLI
#   - claude-agent-sdk
#   - nightshift agent code
#   - Init script
#
# Usage: sudo ./build-rootfs.sh [output_path]
#
set -euo pipefail

OUTPUT="${1:-rootfs.ext4}"
SIZE_MB=2048
MOUNT_DIR="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cleanup() {
    echo "Cleaning up..."
    umount "$MOUNT_DIR/proc" 2>/dev/null || true
    umount "$MOUNT_DIR/dev" 2>/dev/null || true
    umount "$MOUNT_DIR/sys" 2>/dev/null || true
    umount "$MOUNT_DIR" 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
    losetup -D 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Creating sparse ext4 image (${SIZE_MB}MB)..."
dd if=/dev/zero of="$OUTPUT" bs=1M count=0 seek="$SIZE_MB" 2>/dev/null
mkfs.ext4 -F -q "$OUTPUT"

echo "==> Mounting image..."
mount -o loop "$OUTPUT" "$MOUNT_DIR"

echo "==> Bootstrapping Alpine Linux..."
# Install Alpine minimal base
apk_tools_url="https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64/apk-tools-static-2.14.6-r3.apk"
wget -q -O /tmp/apk-tools.apk "$apk_tools_url"
tar xzf /tmp/apk-tools.apk -C /tmp sbin/apk.static

# Install Alpine signing keys so apk can verify packages
mkdir -p "$MOUNT_DIR/etc/apk/keys"
wget -q -O "$MOUNT_DIR/etc/apk/keys/alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub" \
    "https://alpinelinux.org/keys/alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub"

/tmp/sbin/apk.static \
    --arch x86_64 \
    --root "$MOUNT_DIR" \
    --initdb \
    --no-cache \
    --repository "https://dl-cdn.alpinelinux.org/alpine/v3.21/main" \
    --repository "https://dl-cdn.alpinelinux.org/alpine/v3.21/community" \
    add alpine-base busybox openrc git bash curl nodejs npm

echo "==> Setting up chroot environment..."
cp /etc/resolv.conf "$MOUNT_DIR/etc/resolv.conf"
mount --bind /proc "$MOUNT_DIR/proc"
mount --bind /dev "$MOUNT_DIR/dev"
mount --bind /sys "$MOUNT_DIR/sys"

echo "==> Installing Python and uv..."
chroot "$MOUNT_DIR" /bin/sh -c '
    # Install uv
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="/root/.local/bin:$PATH"

    # Install Python 3.12 via uv
    uv python install 3.12

    # Create symlinks so python3/uv/uvx are on the default PATH
    PYTHON_BIN=$(find /root/.local/share/uv/python -name "python3.12" -type f | head -1)
    ln -sf "$PYTHON_BIN" /usr/local/bin/python3
    ln -sf /root/.local/bin/uv /usr/local/bin/uv
    ln -sf /root/.local/bin/uvx /usr/local/bin/uvx
'


echo "==> Installing claude CLI and agent SDK..."
chroot "$MOUNT_DIR" /bin/sh -c '
    export PATH="/root/.local/bin:$PATH"
    npm install -g @anthropic-ai/claude-code
    uv pip install --system --break-system-packages claude-agent-sdk
'

echo "==> Copying nightshift agent code..."
mkdir -p "$MOUNT_DIR/opt/nightshift"
cp -r "$PROJECT_DIR/src/nightshift/agent" "$MOUNT_DIR/opt/nightshift/"
cp -r "$PROJECT_DIR/src/nightshift/sdk" "$MOUNT_DIR/opt/nightshift/"
cp "$PROJECT_DIR/src/nightshift/__init__.py" "$MOUNT_DIR/opt/nightshift/"
cp "$PROJECT_DIR/src/nightshift/events.py" "$MOUNT_DIR/opt/nightshift/"
cp "$PROJECT_DIR/src/nightshift/config.py" "$MOUNT_DIR/opt/nightshift/"
cp -r "$PROJECT_DIR/src/nightshift/protocol" "$MOUNT_DIR/opt/nightshift/"

# Create a minimal pyproject.toml for the agent
cat > "$MOUNT_DIR/opt/nightshift/pyproject.toml" << 'PYPROJECT'
[project]
name = "nightshift-agent"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi",
    "uvicorn",
    "httpx",
    "httpx-sse",
    "sse-starlette",
    "claude-agent-sdk",
]
PYPROJECT

# Install agent dependencies
chroot "$MOUNT_DIR" /bin/sh -c '
    export PATH="/root/.local/bin:$PATH"
    cd /opt/nightshift
    uv sync
'

echo "==> Installing init script..."
cp "$SCRIPT_DIR/init" "$MOUNT_DIR/sbin/init"
chmod +x "$MOUNT_DIR/sbin/init"

echo "==> Creating workspace directory..."
mkdir -p "$MOUNT_DIR/workspace"
mkdir -p "$MOUNT_DIR/etc/nightshift"
mkdir -p "$MOUNT_DIR/opt/nightshift/agent_pkg"

echo "==> Setting up essential filesystems dirs..."
mkdir -p "$MOUNT_DIR/proc" "$MOUNT_DIR/sys" "$MOUNT_DIR/dev" "$MOUNT_DIR/tmp"

echo "==> Unmounting..."
umount "$MOUNT_DIR/proc" 2>/dev/null || true
umount "$MOUNT_DIR/dev" 2>/dev/null || true
umount "$MOUNT_DIR/sys" 2>/dev/null || true
umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"

echo "==> Done! rootfs image: $OUTPUT"
echo "    Size: $(du -sh "$OUTPUT" | cut -f1)"
